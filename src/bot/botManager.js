'use strict';

const EventEmitter = require('events');
const { BotViewer } = require('./viewer');
const { buildInventorySnapshot } = require('./inventory');
const { setAutoToolEnabled, armorUpgradesToEquip } = require('./autoTool');
const { loadConfig } = require('../config/store');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Main inventory + hotbar slots (armor 5–8 and offhand 45 are excluded). */
const isDroppableSlot = (i) => i && i.slot >= 9 && i.slot <= 44;

const CONNECT_TIMEOUT_MS = 20000;

/**
 * BotManager
 * ----------
 * Owns a single Mineflayer bot instance and its lifecycle.
 *
 * State machine: stopped → connecting → connected
 *                          ↘ error / disconnected → stopped
 *
 * Safety:
 *  - A generation counter is bumped on every start(); events from retired
 *    bot instances are ignored, so rapid Start/Reconnect can never let a
 *    stale bot clobber the current state.
 *  - A connect timeout prevents the dashboard from hanging on CONNECTING
 *    when the target host is unreachable.
 *
 * Emits:
 *   'state' (snapshot) — bot state + config, broadcast to the dashboard
 *   'log'   (entry)    — { level, message, time } log line
 */
class BotManager extends EventEmitter {
  constructor({ server, socketAuth } = {}) {
    super();
    this.bot = null;
    this.config = null;
    this.state = 'stopped'; // stopped | connecting | connected | disconnected | error
    this.lastError = null;
    this.hasConnected = false;
    this.logBuffer = [];
    this.MAX_LOG_LINES = 300;
    this.generation = 0;
    this.connectTimer = null;
    this.authSent = { login: false, register: false }; // per-connection guards
    this.lastAuthAt = 0; // cooldown for auto login/register commands
    // Inventory helpers (auto-drop / auto-eat / auto-tool) + live inventory streaming.
    this.invSettings = { autoDropEnabled: false, autoDropItem: '', autoEatEnabled: false, autoEatThreshold: 10, autoToolEnabled: false, autoArmorEnabled: false };
    this.invBusy = false; // one inventory mutation at a time
    this.eating = false; // auto-eat in progress
    this.invRefreshTimer = null;
    this.autoDropTimer = null;
    this.autoEatTimer = null;
    // Follow-player control (Controls page): bot walks to the target in
    // survival mode, or /tp's to them in operator mode when they move
    // farther than `radius` blocks away.
    this.follow = { enabled: false, player: '', mode: 'survival', radius: 5, lastTpAt: 0, lastScanLogAt: 0, lastStatus: null };
    this.followTimer = null;
    this._lastFollowEmit = 0;
    // Guard-player control (Controls page): like follow, but the bot also
    // attacks threats near the protected player. Filters decide which entity
    // buckets to engage: hostile mobs (auto), passive/neutral mobs and other
    // players (retaliation only — they must hit the bot or the protected
    // player first). Entity buckets come from the runtime entity registry:
    // entity.type === 'player' or entity.kind === 'Hostile mobs'.
    this.guard = {
      enabled: false,
      player: '',
      mode: 'survival',
      radius: 5,
      attackRange: 8,
      hostile: true,
      passive: true,
      players: false,
      lastTpAt: 0,
      lastScanLogAt: 0,
      lastStatus: null,
      hurtBy: new Map(), // entityId -> timestamp when it hit the bot/protected player
      lastAttackAt: new Map(), // entityId -> timestamp of last bot attack (per-target cooldown)
      mysteryHurtAt: 0 // fallback: last time we were hurt by an unknown attacker (pre-1.20 servers)
    };
    this.guardTimer = null;
    this._lastGuardEmit = 0;
    // Look-at-players toggle (Controls page): when on, the bot turns its head
    // toward the nearest player every second. Pure look — no movement keys.
    this.look = { enabled: false };
    this.lookTimer = null;
    // Mining control (Controls page): the bot digs a tunnel straight ahead
    // ('straight' — 1x2 wall at body height) or a descending staircase
    // ('stair' — wall at feet height + the step below it, 1 block down per
    // step). Runs as a self-scheduling tick; mutually exclusive with follow/
    // guard (all three drive the same movement keys).
    this.mining = { enabled: false, mode: 'straight', busy: false, blocks: 0, lastLogAt: 0 };
    this.mineTimer = null;
    this._lastMineEmit = 0;
    // One-shot action guard: while the bot is walking to a bed / sleeping, the
    // follow/guard loops must NOT fight for the movement keys, and a second
    // Sleep click must not start an overlapping walk.
    this.sleepBusy = false;
    this.viewer = new BotViewer({ server, socketAuth });
    // Session statistics (surfaced on the Statistics page).
    this.stats = {
      sessions: 0,
      connectedMs: 0, // total time connected across sessions
      sessionStart: 0, // Date.now() of the current session (0 when not in a server)
      lastConnectedAt: null, // ISO timestamp
      distanceWalked: 0, // blocks
      messagesSent: 0,
      commandsSent: 0, // sent messages starting with '/'
      chatReceived: 0,
      itemsDropped: 0,
      autoDrops: 0,
      blocksMined: 0,
      attacks: 0,
      deaths: 0,
      kicks: 0
    };
    this.statsLastPos = null; // last position used for distance accumulation
    this.statsTickAt = 0; // throttle for distance accumulation
    // Live ping to the Minecraft server (ms). Mineflayer updates
    // bot.player.ping ~once per second; we sample it on a 2s timer and
    // surface it in snapshot()/getStats() for the topbar + stats page.
    this.latencyMs = null;
    this.latencyTimer = null;
    // Live terrain (2D map): cached per-chunk surface palette + dirty queue.
    // Filled incrementally (per-tick budget) so the first load never blocks.
    this.terrain = this.freshTerrainState();
    this._blocksCache = null; // { version, data: blocksByStateId } for the live bot version
  }

  /** Fresh (empty) terrain state — used on construction and world resets. */
  freshTerrainState() {
    return { cache: new Map(), dirty: new Set(), anchorX: null, anchorZ: null };
  }

  /** Start (or restart) a bot using the given config. */
  start(config) {
    this.stop(true); // silently retire any previous bot
    this.generation += 1;
    const gen = this.generation;
    this.config = { ...config };
    // Fresh connection = fresh auth state (the new session needs to log in
    // again, and we are allowed to send login/register once more).
    this.authSent = { login: false, register: false };
    this.lastAuthAt = 0;
    this.invSettings = {
      autoDropEnabled: !!config.autoDropEnabled,
      autoDropItem: String(config.autoDropItem || '').trim().toLowerCase(),
      autoEatEnabled: !!config.autoEatEnabled,
      autoEatThreshold: Number(config.autoEatThreshold) || 10,
      autoToolEnabled: !!config.autoToolEnabled,
      autoArmorEnabled: !!config.autoArmorEnabled
    };
    // Follow settings travel with the saved config so they survive restarts.
    this.follow = {
      enabled: !!config.followEnabled,
      player: String(config.followPlayer || '').trim(),
      mode: config.followMode === 'op' ? 'op' : 'survival',
      radius: Number(config.followRadius) || 5,
      lastTpAt: 0,
      lastScanLogAt: 0,
      lastStatus: null
    };
    // Guard settings also travel with the saved config. Attack filters are
    // booleans so a missing field (old config) defaults to ON, not OFF.
    this.guard = {
      enabled: !!config.guardEnabled,
      player: String(config.guardPlayer || '').trim(),
      mode: config.guardMode === 'op' ? 'op' : 'survival',
      radius: Number(config.guardRadius) || 5,
      attackRange: Math.max(2, Math.min(16, Number(config.guardAttackRange) || 8)),
      hostile: config.guardHostile !== false,
      passive: config.guardPassive !== false,
      players: !!config.guardPlayers,
      lastTpAt: 0,
      lastScanLogAt: 0,
      lastStatus: null,
      hurtBy: new Map(),
      lastAttackAt: new Map(),
      mysteryHurtAt: 0
    };
    // Mutual-exclusion safety net: even if config.json somehow ends up with
    // BOTH follow and guard enabled (e.g. hand-edited), the bot must never
    // run both loops — follow wins and guard yields. The socket save also
    // persists the other's flag off, so this only guards hand-edited files.
    if (this.follow.enabled && this.guard.enabled) this.guard.enabled = false;
    this.look = { enabled: !!config.lookAtPlayers };
    // Mining settings travel with the saved config so they survive restarts.
    // Mining and follow/guard are mutually exclusive — hand-edited configs
    // with both armed are resolved by disabling follow/guard (mining wins).
    this.mining = {
      enabled: !!config.miningEnabled,
      mode: config.miningMode === 'stair' ? 'stair' : 'straight',
      busy: false,
      blocks: 0,
      lastLogAt: 0
    };
    if (this.mining.enabled) {
      this.follow.enabled = false;
      this.guard.enabled = false;
    }
    this.eating = false;
    this.state = 'connecting';
    this.lastError = null;
    this.emit('state', this.snapshot());
    this.emitLog('info', `Starting bot "${config.botName}" → ${config.serverIp}:${config.serverPort} (MC ${config.version})`);

    try {
      this.connect(gen);
    } catch (err) {
      this.handleError(err);
    }
  }

  connect(gen) {
    const mineflayer = require('mineflayer');
    const { botName, serverIp, serverPort, version, auth } = this.config;

    const bot = mineflayer.createBot({
      host: serverIp,
      port: serverPort,
      username: botName,
      version,
      auth: auth || 'offline',
      hideErrors: true // we surface errors through the dashboard log instead
    });

    this.bot = bot;

    // Live ping sampling — read bot.player.ping (updated by mineflayer
    // roughly every second) and keep the latest value. unref()d so the
    // timer never holds the process open in tests.
    this.latencyMs = null;
    clearInterval(this.latencyTimer);
    this.latencyTimer = setInterval(() => {
      if (isStale()) return;
      const p = bot.player && bot.player.ping;
      if (typeof p === 'number' && Number.isFinite(p) && p >= 0) {
        this.latencyMs = Math.round(p);
      }
    }, 2000);
    this.latencyTimer.unref();

    // Bounded connect window — an unreachable host must not leave the
    // dashboard stuck on CONNECTING forever.
    this.connectTimer = setTimeout(() => {
      if (gen !== this.generation || this.state !== 'connecting') return;
      this.lastError = `Connection timed out — could not reach ${serverIp}:${serverPort}. Check the IP/port and try again.`;
      this.state = 'error';
      this.emitLog('error', this.lastError);
      this.emit('state', this.snapshot());
      try {
        bot.end('Connection timed out');
      } catch (_) {
        /* ignore */
      }
    }, CONNECT_TIMEOUT_MS);

    // Guards: `gen !== this.generation` skips events from retired bot
    // instances (rapid restart); `this.bot !== bot` skips events from a
    // bot that was explicitly stopped. Together they make stale events
    // harmless.
    const isStale = () => gen !== this.generation || this.bot !== bot;

    // Accumulate distance walked (cheap, throttled to ~5Hz).
    bot.on('move', () => {
      if (isStale()) return;
      const now = Date.now();
      if (now - this.statsTickAt < 200) return;
      this.statsTickAt = now;
      try {
        const p = bot.entity && bot.entity.position;
        if (p && this.statsLastPos) {
          this.stats.distanceWalked += p.distanceTo(this.statsLastPos);
        }
        this.statsLastPos = p ? p.clone() : null;
      } catch (_) {
        /* ignore */
      }
    });

    bot.once('spawn', () => {
      if (isStale()) return;
      clearTimeout(this.connectTimer);
      this.stats.sessions += 1;
      this.stats.sessionStart = Date.now();
      this.stats.lastConnectedAt = new Date().toISOString();
      const pos = bot.entity ? bot.entity.position : null;
      // Fresh world -> fresh terrain (dimension/server changes reset the tiles).
      this.terrain = this.freshTerrainState();
      this._blocksCache = null;
      this.state = 'connected';
      this.hasConnected = true;
      this.emit('state', this.snapshot());
      this.emitLog(
        'success',
        `Connected! Position: ${pos ? `x=${Math.round(pos.x)} y=${Math.round(pos.y)} z=${Math.round(pos.z)}` : 'unknown'}`
      );

      // Live 3D view of the bot's surroundings.
      this.viewer.attach(bot);
      // Stream the inventory and start the auto-drop / auto-eat loops.
      this.emitInventory();
      this.startInvLoops();
      // Re-arm the follow/guard/look loops if they were enabled before the restart.
      this.restartFollowLoop();
      this.restartGuardLoop();
      this.restartLookLoop();
      this.restartMiningLoop();
      // Wrap dig/attack so the bot auto-equips its best tool when enabled.
      this.applyAutoTool();
      // Put on the best available armor right away (not just on the next tick).
      if (this.invSettings.autoArmorEnabled) this.autoArmorTick();
    });

    bot.on('chat', (username, message) => {
      if (isStale()) return;
      this.stats.chatReceived += 1;
      this.emitLog('chat', `<${username}> ${message}`);
      // Never echo our own AI-sent messages back into the AI loop.
      if (username === bot.username) return;
      // Hook for the AI in-game chat bridge (server.js wires it up).
      this.emit('game-chat', { username, message });
      // Auto login/register when the server asks (AuthMe-style plugins).
      this.maybeAutoAuth(message);
    });

    // ---- Terrain tracking (2D map live layer) ----
    // Keep the surface cache fresh: queue a chunk for recompute when a block
    // inside it changes, or when a chunk column loads/unloads.
    const markDirtyPos = (pos) => {
      if (isStale() || !pos || typeof pos.x !== 'number') return;
      this.terrain.dirty.add(Math.floor(pos.x / 16) + ',' + Math.floor(pos.z / 16));
    };
    bot.on('chunkColumnLoad', (corner) => markDirtyPos(corner));
    bot.on('chunkColumnUnload', (corner) => {
      if (isStale() || !corner) return;
      const k = Math.floor(corner.x / 16) + ',' + Math.floor(corner.z / 16);
      this.terrain.cache.delete(k);
      this.terrain.dirty.delete(k);
    });
    bot.on('blockUpdate', (oldBlock, newBlock) => markDirtyPos(newBlock && newBlock.position ? newBlock.position : null));

    // Re-broadcast the inventory promptly when XP or potion effects change.
    bot.on('experience', () => {
      if (!isStale()) this.emitInventory();
    });
    bot.on('entityEffect', (entity) => {
      if (!isStale() && entity === bot.entity) this.emitInventory();
    });
    bot.on('entityEffectEnd', (entity) => {
      if (!isStale() && entity === bot.entity) this.emitInventory();
    });

    bot.on('death', () => {
      if (isStale()) return;
      this.stats.deaths += 1;
      this.emitLog('warn', 'The bot died!');
    });

    // Guard retaliation bookkeeping: whenever the BOT or the protected player
    // is hurt, remember who did it (mineflayer passes the attacker entity as
    // the second arg on 1.20+ damage_event packets). On older MC versions the
    // attacker is NOT delivered (entityHurt fires from entity_status without a
    // source) — so record a timestamp and let the guard loop retaliate against
    // the nearest eligible entity as a fallback.
    bot.on('entityHurt', (entity, source) => {
      if (isStale()) return;
      if (!entity) return;
      const isBot = entity === bot.entity;
      const isProtected =
        this.guard.player &&
        entity.type === 'player' &&
        String(entity.username || '').toLowerCase() === this.guard.player.toLowerCase();
      if (!isBot && !isProtected) return;
      if (source) {
        this.guard.hurtBy.set(source.id, Date.now());
      } else {
        this.guard.mysteryHurtAt = Date.now();
      }
    });

    bot.on('kicked', (reason) => {
      if (isStale()) return;
      this.stats.kicks += 1;
      this.emitLog('warn', `Kicked from server: ${reason || 'no reason given'}`);
    });

    bot.on('error', (err) => {
      if (isStale()) return;
      this.handleError(err);
    });

    bot.on('end', (reason) => {
      if (isStale()) return;
      clearTimeout(this.connectTimer);
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
      this.latencyMs = null;
      this.stopInvLoops();
      this.stopFollowLoop(); // release control states + stop the timer
      this.stopGuardLoop();
      this.stopLookLoop();
      this.stopMiningLoop();
      this.viewer.detach();
      this.finishSession();
      this.terrain = this.freshTerrainState();
      this._blocksCache = null;
      this.bot = null;
      if (this.state === 'connecting' || this.state === 'connected') {
        this.state = 'disconnected';
        this.emitLog('warn', `Disconnected${reason ? ` — ${reason}` : ''}`);
        this.emit('state', this.snapshot());
      }
    });
  }

  /** Close out the current stats session (accumulate connected time). */
  finishSession() {
    if (this.stats.sessionStart) {
      this.stats.connectedMs += Date.now() - this.stats.sessionStart;
      this.stats.sessionStart = 0;
    }
    this.statsLastPos = null;
  }

  /** Stop the current bot (if any). */
  stop(silent = false) {
    clearTimeout(this.connectTimer);
    clearInterval(this.latencyTimer);
    this.latencyTimer = null;
    this.latencyMs = null;
    this.stopInvLoops();
    this.stopFollowLoop();
    this.stopGuardLoop();
    this.stopLookLoop();
    this.stopMiningLoop();
    this.viewer.detach();
    this.finishSession();
    if (this.bot) {
      const bot = this.bot;
      this.bot = null;
      try {
        bot.end('Bot stopped by user');
      } catch (_) {
        /* ignore */
      }
    }
    this.state = 'stopped';
    if (!silent) {
      this.emitLog('info', 'Bot stopped');
      this.emit('state', this.snapshot());
    }
  }

  /**
   * Auto-login/register against auth-plugin servers (AuthMe etc.).
   * Scans each chat message for a login/register prompt and answers it once
   * per connection — never spamming the server (cooldown + per-session guard
   * prevent the "already logged in" retry loop).
   */
  maybeAutoAuth(message) {
    const cfg = this.config || {};
    if (!cfg.loginEnabled || !cfg.loginAutoDetect) return;
    if (this.state !== 'connected' || !this.bot) return;

    const decision = decideAuthCommand(message, {
      password: cfg.loginPassword,
      sentLogin: this.authSent.login,
      sentRegister: this.authSent.register
    });
    if (!decision) return;

    const now = Date.now();
    const delayMs = (Number(cfg.loginDelaySeconds) || 5) * 1000;
    if (now - this.lastAuthAt < delayMs) return; // cooldown between attempts

    this.authSent[decision.type] = true;
    this.lastAuthAt = now;
    this.sendAuthCommand(decision.command);
    this.emitLog('info', `🔑 Server asked to ${decision.type} — ${decision.type === 'register' ? 'registration' : 'login'} command sent.`);
  }

  /** Send an auth command silently (never log the password). */
  sendAuthCommand(command) {
    if (!this.bot || this.state !== 'connected') return false;
    try {
      this.bot.chat(command);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Send a message to the Minecraft chat as the bot. Returns false if offline. */
  sendChat(message) {
    const text = String(message || '').trim();
    if (!text || this.state !== 'connected' || !this.bot) return false;
    try {
      this.bot.chat(text);
      this.stats.messagesSent += 1;
      if (text.startsWith('/')) this.stats.commandsSent += 1;
      this.emitLog('chat', `[Bot] ${text}`);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Dig the nearest block with a given name (within 5 blocks). Auto-tool
   * equips the best pickaxe/axe/shovel for the block before digging.
   * Returns { ok, block } or { ok:false, error }.
   */
  async mineBlock(name) {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    const target = String(name || '').trim().toLowerCase();
    if (!target) return { ok: false, error: 'Block name is required.' };
    const bot = this.bot;
    const block = bot.findBlock({
      matching: (b) => b && b.name === target,
      maxDistance: 5
    });
    if (!block) return { ok: false, error: `No "${target}" block within 5 blocks of the bot.` };
    try {
      // bot.dig may be wrapped by auto-tool -> best tool equipped first.
      await bot.dig(block);
      this.stats.blocksMined += 1;
      this.emitLog('success', `⛏ Mined ${target} at ${Math.round(block.position.x)}, ${Math.round(block.position.y)}, ${Math.round(block.position.z)}`);
      return { ok: true, block: target };
    } catch (err) {
      return { ok: false, error: extractErrorMessage(err) };
    }
  }

  /**
   * Attack the nearest entity — or, when a target name is given, the nearest
   * entity matching that name (mob name or player username) within 16 blocks.
   * Auto-tool equips the best sword before the attack.
   * Returns { ok, target } or { ok:false, error }.
   */
  async attackEntity(targetName) {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    const bot = this.bot;
    const me = bot.entity;
    const t = String(targetName || '').trim().toLowerCase();
    const inRange = (e) =>
      e && e.id !== me.id && e.position && me.position && e.position.distanceTo(me.position) < 16;

    let entity = null;
    if (t) {
      const named = Object.values(bot.entities).filter(inRange).find(
        (e) => String(e.name || '').toLowerCase() === t || String(e.username || '').toLowerCase() === t
      );
      if (named) entity = named;
    }
    if (!entity) {
      // Prefer a living target (mob/player); fall back to any nearby entity.
      entity = bot.nearestEntity((e) => inRange(e) && (e.type === 'mob' || e.type === 'player'));
      if (!entity) entity = bot.nearestEntity(inRange);
    }
    if (!entity) return { ok: false, error: t ? `No "${t}" entity within 16 blocks.` : 'No entity within 16 blocks to attack.' };

    try {
      // bot.attack may be wrapped by auto-tool -> best sword equipped first.
      await bot.attack(entity);
      this.stats.attacks += 1;
      this.emitLog('warn', `⚔ Attacked ${entity.name || entity.username || 'entity'}`);
      return { ok: true, target: entity.name || entity.username || 'entity' };
    } catch (err) {
      return { ok: false, error: extractErrorMessage(err) };
    }
  }

  /* ============================================================
     Inventory
     ============================================================ */

  /** Latest normalized inventory snapshot, or null when not in a server. */
  getInventory() {
    if (this.state !== 'connected' || !this.bot) return null;
    try {
      return buildInventorySnapshot(this.bot);
    } catch (err) {
      this.emitLog('warn', `Could not read inventory: ${extractErrorMessage(err)}`);
      return null;
    }
  }

  /** Broadcast the current inventory to all dashboard clients. */
  emitInventory() {
    const snap = this.getInventory();
    if (snap) this.emit('inventory', snap);
  }

  /**
   * Broadcast the inventory now, then again after a short settle.
   * Mineflayer's moveSlotItem/equip resolve on the click ACK, but the actual
   * slot data arrives a moment later in set_slot / window_items packets — so
   * a single immediate emit often shows the pre-move layout (the "armor moved
   * in-game but the UI didn't update" bug). Re-emitting after ~450ms catches
   * the settled state without making the UI feel slow.
   */
  emitInventorySettled(delayMs = 450) {
    this.emitInventory();
    const t = setTimeout(() => {
      // Only refresh if we're still connected to the same session.
      if (this.state === 'connected' && this.bot) this.emitInventory();
    }, delayMs);
    if (t && typeof t.unref === 'function') t.unref();
  }

  /**
   * 2D radar snapshot: the bot's position/heading + every entity within
   * RADAR_RADIUS blocks, with screen-relevant fields for the 2D map page.
   * Returns null when not in a server.
   */
  getRadar() {
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) return null;
    const bot = this.bot;
    const me = bot.entity;
    const RADIUS = 256;
    const entities = [];
    for (const e of Object.values(bot.entities)) {
      if (!e || e === me || !e.position || !e.type) continue;
      const dx = e.position.x - me.position.x;
      const dz = e.position.z - me.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > RADIUS) continue;
      entities.push({
        id: e.id,
        name: e.name || null,
        username: e.username || null,
        type: e.type, // mob | player | object | projectile | other
        x: Math.round(e.position.x * 10) / 10,
        y: Math.round(e.position.y * 10) / 10,
        z: Math.round(e.position.z * 10) / 10,
        distance: Math.round(dist)
      });
    }
    entities.sort((a, b) => a.distance - b.distance);
    return {
      bot: {
        name: bot.username,
        x: Math.round(me.position.x * 10) / 10,
        y: Math.round(me.position.y * 10) / 10,
        z: Math.round(me.position.z * 10) / 10,
        yaw: me.yaw || 0,
        health: typeof bot.health === 'number' ? bot.health : null,
        food: typeof bot.food === 'number' ? bot.food : null
      },
      radius: RADIUS,
      count: entities.length,
      entities
    };
  }

  /**
   * Compact entity list around the bot for the AI ([output:nearby:...]).
   * filter: 'entities' (everything), 'player', 'mobhostile' or 'mobpassive'.
   * Returns { count, filter, radius, entities } or null when not in a server.
   */
  getNearbyEntities({ filter = 'entities', radius = 16 } = {}) {
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) return null;
    const bot = this.bot;
    const me = bot.entity;
    const r = Math.max(1, Math.min(128, Number(radius) || 16));
    const wanted = String(filter || 'entities').toLowerCase();
    const out = [];
    for (const e of Object.values(bot.entities)) {
      if (!e || e === me || !e.position || !e.type) continue;
      const dist = me.position.distanceTo(e.position);
      if (dist > r) continue;
      const bucket = guardBucket(e); // 'hostile' | 'passive' | 'player' | null
      if (wanted === 'player' && bucket !== 'player') continue;
      if (wanted === 'mobhostile' && bucket !== 'hostile') continue;
      if (wanted === 'mobpassive' && bucket !== 'passive') continue;
      out.push({
        name: e.username || e.displayName || e.name || (e.type === 'player' ? 'player' : 'entity'),
        type: e.type,
        kind: e.kind || null,
        bucket: bucket || (e.type === 'player' ? 'player' : 'other'),
        distance: Math.round(dist * 10) / 10
      });
    }
    out.sort((a, b) => a.distance - b.distance);
    return { count: out.length, filter: wanted, radius: r, entities: out };
  }

  /**
   * Live terrain layer for the 2D map.
   *
   * Maintains a per-chunk surface cache (block palette indices) around the
   * bot. Each call recomputes at most a small budget of dirty/missing chunks
   * so the event loop is never blocked, and returns only the chunks that
   * actually changed — the client tiles them onto the canvas.
   *
   * Returns { type:'chunks', chunks:[{x,z,data}] } when something changed,
   * { type:'reset' } when the bot world jumped (clear client tiles), or null.
   */
  refreshTerrain() {
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) return null;
    const bot = this.bot;
    const me = bot.entity;
    const R = 128; // blocks around the bot (matches the 2D map max range)
    const cx = Math.floor(me.position.x);
    const cz = Math.floor(me.position.z);
    const blocks = this.getBlocksById(bot.version);
    if (!blocks) return null;

    const ter = this.terrain;
    // Teleport / dimension jump (farther than the radius): reset everything
    // so stale tiles never linger on the client.
    if (ter.anchorX !== null && Math.hypot(cx - ter.anchorX, cz - ter.anchorZ) > R * 4) {
      ter.cache.clear();
      ter.dirty.clear();
      ter.anchorX = cx;
      ter.anchorZ = cz;
      return { type: 'reset' };
    }
    if (ter.anchorX === null) {
      ter.anchorX = cx;
      ter.anchorZ = cz;
    }

    // Queue every in-range chunk we don't have cached yet.
    const minCX = Math.floor((cx - R) / 16);
    const maxCX = Math.floor((cx + R) / 16);
    const minCZ = Math.floor((cz - R) / 16);
    const maxCZ = Math.floor((cz + R) / 16);
    for (let zz = minCZ; zz <= maxCZ; zz++) {
      for (let xx = minCX; xx <= maxCX; xx++) {
        const k = xx + ',' + zz;
        if (!ter.cache.has(k)) ter.dirty.add(k);
      }
    }

    const changed = [];
    const started = Date.now();
    const dirty = [];
    for (const k of ter.dirty) {
      const sep = k.indexOf(',');
      const cxx = Number(k.slice(0, sep));
      const czz = Number(k.slice(sep + 1));
      const dx = cxx * 16 + 8 - cx;
      const dz = czz * 16 + 8 - cz;
      dirty.push({ k, cxx, czz, d2: dx * dx + dz * dz });
    }
    dirty.sort((a, b) => a.d2 - b.d2);
    // Recompute a bounded TIME budget of dirty chunks per tick. While the
    // initial fill is in flight there are many dirty chunks, so we allow a
    // larger slice of the 400ms tick window (~2.5x faster first load); once
    // the map is mostly cached the budget stays small so the event loop is
    // never blocked. Nearest chunks first — the map fills outward from the
    // bot like a real map growing around you.
    const BUDGET_MS = dirty.length > 64 ? 140 : 60;
    for (const d of dirty) {
      if (Date.now() - started >= BUDGET_MS) break;
      ter.dirty.delete(d.k);
      const col = bot.world.getColumn(d.cxx, d.czz);
      if (!col) continue; // not loaded yet — retried next tick
      const surface = computeChunkSurface(col, blocks);
      ter.cache.set(d.k, surface);
      changed.push({ x: d.cxx, z: d.czz, data: encodeTerrainChunk(surface) });
    }
    if (!changed.length) return null;
    return { type: 'chunks', chunks: changed };
  }

  /**
   * Full snapshot of every cached terrain chunk — sent to freshly connected
   * clients so a page reload instantly shows the map instead of waiting for
   * the next delta. Returns null when nothing is cached yet.
   */
  getTerrainSnapshot() {
    const chunks = [];
    for (const [k, surface] of this.terrain.cache) {
      const sep = k.indexOf(',');
      chunks.push({
        x: Number(k.slice(0, sep)),
        z: Number(k.slice(sep + 1)),
        data: encodeTerrainChunk(surface)
      });
    }
    if (!chunks.length) return null;
    return { type: 'chunks', chunks };
  }

  /** Cached minecraft-data blocksByStateId table for the bot's version. */
  getBlocksById(version) {
    if (this._blocksCache && this._blocksCache.version === version) return this._blocksCache.data;
    let data = null;
    try {
      data = require('minecraft-data')(version).blocksByStateId || null;
    } catch (_) {
      data = null;
    }
    if (!data) {
      this.emitLog('warn', `Terrain colours unavailable for Minecraft ${version} — the 2D map will show the grid only.`);
    }
    this._blocksCache = { version, data };
    return data;
  }

  /** Statistics snapshot for the Statistics page. */
  getStats() {
    const s = this.stats;
    return {
      sessions: s.sessions,
      connectedMs: Math.round(s.connectedMs),
      sessionUptimeMs: s.sessionStart ? Date.now() - s.sessionStart : 0,
      lastConnectedAt: s.lastConnectedAt,
      distanceWalked: Math.round(s.distanceWalked),
      messagesSent: s.messagesSent,
      commandsSent: s.commandsSent,
      chatReceived: s.chatReceived,
      itemsDropped: s.itemsDropped,
      autoDrops: s.autoDrops,
      blocksMined: s.blocksMined,
      attacks: s.attacks,
      deaths: s.deaths,
      kicks: s.kicks,
      latencyMs: this.latencyMs
    };
  }

  /** Start the inventory refresh + auto-drop + auto-eat loops. */
  startInvLoops() {
    this.stopInvLoops();
    // Re-scan every 5s while in a server so pickups / external changes show up.
    this.invRefreshTimer = setInterval(() => this.emitInventory(), 5000);
    this.restartAutoLoops();
  }

  /** Clear all inventory timers. */
  stopInvLoops() {
    for (const t of ['invRefreshTimer', 'autoDropTimer', 'autoEatTimer', 'autoArmorTimer']) {
      if (this[t]) {
        clearInterval(this[t]);
        this[t] = null;
      }
    }
  }

  /** Re-arm the auto-drop / auto-eat / auto-armor timers from the current settings. */
  restartAutoLoops() {
    if (this.autoDropTimer) clearInterval(this.autoDropTimer);
    if (this.autoEatTimer) clearInterval(this.autoEatTimer);
    if (this.autoArmorTimer) clearInterval(this.autoArmorTimer);
    this.autoDropTimer = null;
    this.autoEatTimer = null;
    this.autoArmorTimer = null;
    if (this.invSettings.autoDropEnabled && this.invSettings.autoDropItem) {
      this.autoDropTimer = setInterval(() => this.autoDropTick(), 4000);
    }
    if (this.invSettings.autoEatEnabled) {
      this.autoEatTimer = setInterval(() => this.autoEatTick(), 4000);
    }
    if (this.invSettings.autoArmorEnabled) {
      this.autoArmorTimer = setInterval(() => this.autoArmorTick(), 4000);
    }
  }

  /** Auto-drop loop: throw away every stack matching the configured name. */
  async autoDropTick() {
    if (this.invBusy || this.state !== 'connected' || !this.bot) return;
    const target = this.invSettings.autoDropItem;
    if (!target) return;
    this.invBusy = true;
    try {
      const matches = this.bot.inventory
        .items()
        .filter((i) => isDroppableSlot(i) && String(i.name).toLowerCase() === target);
      this.closeOpenContainer();
      for (const item of matches) {
        if (this.state !== 'connected' || !this.bot) break;
        try {
          await this.bot.tossStack(item);
        } catch (_) {
          /* slot changed mid-toss — skip */
        }
        await delay(80);
      }
      if (matches.length) {
        this.stats.autoDrops += matches.length;
        this.emitInventory();
      }
    } finally {
      this.invBusy = false;
    }
  }

  /** Auto-eat loop: equip food and eat when hunger drops to the threshold. */
  async autoEatTick() {
    if (this.eating || this.invBusy || this.state !== 'connected' || !this.bot) return;
    const bot = this.bot;
    const threshold = this.invSettings.autoEatThreshold;
    if (typeof bot.food !== 'number' || bot.food > threshold) return;
    const food = bot.inventory.items().find((i) => bot.registry && bot.registry.foods && bot.registry.foods[i.type]);
    if (!food) return;
    this.eating = true;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      this.emitInventory();
    } catch (_) {
      // "Food is full", consume timeouts, equip hiccups — retry next tick.
    } finally {
      this.eating = false;
    }
  }

  /**
   * One-shot eat: find food, equip it and consume it now (independent of the
   * auto-eat loop). Returns { ok, food } or { ok:false, error }.
   */
  async eat() {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    if (this.eating || this.invBusy) return { ok: false, error: 'Another inventory action is running.' };
    const bot = this.bot;
    const food = bot.inventory.items().find((i) => bot.registry && bot.registry.foods && bot.registry.foods[i.type]);
    if (!food) return { ok: false, error: 'No food in the inventory to eat.' };
    this.eating = true;
    try {
      this.closeOpenContainer();
      await bot.equip(food, 'hand');
      await bot.consume();
      this.emitInventorySettled();
      this.emitLog('info', `🍖 Ate ${food.displayName || food.name}`);
      return { ok: true, food: food.displayName || food.name };
    } catch (err) {
      return { ok: false, error: extractErrorMessage(err) };
    } finally {
      this.eating = false;
    }
  }

  /** Drop every item in the inventory. Returns { ok, dropped } or { ok:false, error }. */
  async dropAll() {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    if (this.invBusy) return { ok: false, error: 'Another inventory action is running.' };
    this.invBusy = true;
    try {
      const bot = this.bot;
      // Main inventory + hotbar only (slots 9–44) — never strip equipped armor/offhand.
      const targets = bot.inventory.items().filter((i) => isDroppableSlot(i));
      this.closeOpenContainer();
      let dropped = 0;
      for (const item of targets) {
        if (this.state !== 'connected' || !this.bot || this.bot !== bot) break;
        try {
          await bot.tossStack(item);
          dropped++;
        } catch (_) {
          /* keep going */
        }
        await delay(90);
      }
      this.stats.itemsDropped += dropped;
      this.emitInventorySettled();
      return { ok: true, dropped };
    } finally {
      this.invBusy = false;
    }
  }

  /**
   * Drop every stack matching a given item name — or up to `count` items
   * when a count is supplied (uses bot.toss, spreading across stacks).
   * Returns { ok, dropped: stacksTossed, items: totalItems } or { ok:false, error }.
   */
  async dropItem(name, count) {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    if (this.invBusy) return { ok: false, error: 'Another inventory action is running.' };
    const target = String(name || '').trim().toLowerCase();
    if (!target) return { ok: false, error: 'Item name is required.' };
    const limit = Number(count) > 0 ? Number(count) : Infinity;
    this.invBusy = true;
    try {
      const bot = this.bot;
      const matches = bot.inventory
        .items()
        .filter((i) => isDroppableSlot(i) && String(i.name).toLowerCase() === target);
      if (!matches.length) {
        // Honest failure: never report a successful drop of 0 items — the AI
        // would tell the user "dropped" when nothing happened.
        return { ok: false, error: `No "${target}" in the inventory to drop.` };
      }
      this.closeOpenContainer();
      let dropped = 0; // stacks tossed
      let items = 0; // total item count dropped
      let remaining = limit;
      for (const item of matches) {
        if (this.state !== 'connected' || !this.bot || this.bot !== bot) break;
        if (remaining <= 0) break;
        try {
          if (limit === Infinity) {
            await bot.tossStack(item);
            items += item.count || 1;
            dropped += 1;
          } else {
            const take = Math.min(item.count || 1, remaining);
            await bot.toss(item.type, item.metadata, take);
            items += take;
            remaining -= take;
            dropped += 1;
          }
        } catch (_) {
          /* keep going */
        }
        await delay(90);
      }
      this.stats.itemsDropped += items;
      this.emitInventorySettled();
      if (dropped === 0) {
        // Every toss failed (slot changed mid-toss / inventory re-synced) —
        // report it instead of claiming a successful drop.
        return { ok: false, error: `Could not drop "${target}" — the inventory changed while dropping. Try again.` };
      }
      return { ok: true, dropped, items };
    } finally {
      this.invBusy = false;
    }
  }

  /**
   * Move (or swap) an item between two slots of the open window.
   * Uses bot.moveSlotItem which picks the item up, places it on the
   * destination (swapping if occupied) and puts any held item back.
   * Returns { ok, fromSlot, toSlot } or { ok:false, error }.
   */
  async moveItem(fromSlot, toSlot) {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    const a = Number(fromSlot);
    const b = Number(toSlot);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      return { ok: false, error: 'Invalid slot numbers.' };
    }
    if (a === b) return { ok: false, error: 'Source and destination are the same slot.' };
    if (this.invBusy) return { ok: false, error: 'Another inventory action is running.' };
    this.invBusy = true;
    try {
      this.closeOpenContainer();
      await this.bot.moveSlotItem(a, b);
      this.emitInventorySettled();
      return { ok: true, fromSlot: a, toSlot: b };
    } catch (err) {
      return { ok: false, error: extractErrorMessage(err) };
    } finally {
      this.invBusy = false;
    }
  }

  /**
   * Equip the item in the given slot in the bot's hand. bot.equip with
   * 'hand' automatically moves a non-hotbar item into the hotbar first,
   * so items anywhere in the inventory can be held.
   * Returns { ok, name, slot } or { ok:false, error }.
   */
  async equipItem(slot) {
    if (this.state !== 'connected' || !this.bot) return { ok: false, error: 'Bot is not in a server.' };
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 0) return { ok: false, error: 'Invalid slot number.' };
    if (this.invBusy) return { ok: false, error: 'Another inventory action is running.' };
    this.invBusy = true;
    try {
      this.closeOpenContainer();
      const item = this.bot.inventory.slots[s];
      if (!item) return { ok: false, error: 'That slot is empty.' };
      await this.bot.equip(item, 'hand');
      this.emitInventorySettled();
      this.emitLog('info', `✋ Equipped ${item.displayName || item.name} in hand`);
      return { ok: true, name: item.displayName || item.name, slot: s };
    } catch (err) {
      return { ok: false, error: extractErrorMessage(err) };
    } finally {
      this.invBusy = false;
    }
  }

  /** Update auto-drop settings at runtime (no bot restart needed). */
  setAutoDrop({ enabled, itemName } = {}) {
    this.invSettings.autoDropEnabled = !!enabled;
    this.invSettings.autoDropItem = String(itemName || '').trim().toLowerCase();
    if (this.state === 'connected') this.restartAutoLoops();
  }

  /** Update auto-eat settings at runtime. */
  setAutoEat({ enabled, threshold } = {}) {
    this.invSettings.autoEatEnabled = !!enabled;
    this.invSettings.autoEatThreshold = Number(threshold) || 10;
    if (this.state === 'connected') this.restartAutoLoops();
  }

  /**
   * Auto-tool: equip the best pickaxe/axe/shovel before digging and the best
   * sword before attacking. Applies immediately (no bot restart needed) by
   * wrapping the live bot's dig/attack methods.
   */
  applyAutoTool() {
    if (!this.bot) return;
    setAutoToolEnabled(this.bot, this.invSettings.autoToolEnabled, {
      closeContainer: () => this.closeOpenContainer(),
      onEquip: (item) => this.emitLog('info', `🛠 Auto-tool: equipped ${item.displayName || item.name}`)
    });
  }

  /** Update the auto-tool setting at runtime. */
  setAutoTool({ enabled } = {}) {
    this.invSettings.autoToolEnabled = !!enabled;
    if (this.state === 'connected') this.applyAutoTool();
  }

  /**
   * Auto-armor loop: if the bot owns a better piece for a slot than what it's
   * wearing, equip it (best material tier per slot). Runs every 4s while
   * enabled + connected.
   */
  async autoArmorTick() {
    if (this.invBusy || this.state !== 'connected' || !this.bot) return;
    const bot = this.bot;
    const upgrades = armorUpgradesToEquip(
      {
        head: bot.inventory.slots[5] || null,
        torso: bot.inventory.slots[6] || null,
        legs: bot.inventory.slots[7] || null,
        feet: bot.inventory.slots[8] || null
      },
      bot.inventory.items().filter((i) => i.slot >= 9), // never re-select what's already worn
      bot.registry
    );
    if (!upgrades.length) return;
    this.invBusy = true;
    try {
      this.closeOpenContainer();
      for (const { item, dest } of upgrades) {
        if (this.state !== 'connected' || !this.bot || this.bot !== bot) break;
        try {
          await bot.equip(item, dest);
          this.emitLog('info', `🛡 Auto-armor: equipped ${item.displayName || item.name}`);
        } catch (_) {
          /* slot changed / busy — retry next tick */
        }
        await delay(80);
      }
      this.emitInventory();
    } finally {
      this.invBusy = false;
    }
  }

  /** Update the auto-armor setting at runtime (no bot restart needed). */
  setAutoArmor({ enabled } = {}) {
    this.invSettings.autoArmorEnabled = !!enabled;
    if (this.state === 'connected') {
      this.restartAutoLoops();
      if (this.invSettings.autoArmorEnabled) this.autoArmorTick(); // equip now, don't wait for the timer
    }
  }

  /**
   * Follow-player control (Controls page).
   *
   * Survival mode: the bot looks at the target and walks toward them,
   * jumping when a block blocks the way. Operator mode: the bot uses
   * `/tp <player>` (throttled) whenever the target drifts beyond the
   * configured radius. Scanning runs once per second while enabled.
   */
  setFollow({ enabled, player, mode, radius } = {}) {
    this.follow.enabled = !!enabled;
    this.follow.player = String(player || '').trim();
    this.follow.mode = mode === 'op' ? 'op' : 'survival';
    this.follow.radius = Math.max(1, Math.min(128, Number(radius) || 5));
    // Follow and Guard are mutually exclusive behaviours (both drive the same
    // movement keys) — enabling one disables the other. Mining is excluded too
    // (it owns the movement keys + head while digging).
    if (this.follow.enabled) {
      this.stopGuardLoop();
      this.guard.enabled = false;
      this.stopMiningLoop();
      this.mining.enabled = false;
    }
    this.restartFollowLoop();
  }

  /** (Re)start the 1s follow scan — only while connected with a target set. */
  restartFollowLoop() {
    this.stopFollowLoop();
    if (!this.follow.enabled || !this.follow.player) {
      this.emitFollowStatus('off');
      return;
    }
    if (this.state !== 'connected' || !this.bot) {
      this.emitFollowStatus('waiting', { reason: 'Bot is not in a server.' });
      return;
    }
    this.followTimer = setInterval(() => this.followTick(), 1000);
    this.followTimer.unref();
    this.emitFollowStatus('scanning');
    this.followTick(); // first scan immediately
  }

  /** Stop the follow timer + release any held control states. */
  stopFollowLoop() {
    if (this.followTimer) {
      clearInterval(this.followTimer);
      this.followTimer = null;
    }
    if (this.bot && this.state === 'connected') {
      try {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * One follow scan: locate the target player, decide what to do and do it.
   * The decision is delegated to the pure decideFollowAction() helper so it
   * is unit-testable without a live bot.
   */
  followTick() {
    if (this.sleepBusy) return; // walking to a bed / sleeping — hands off movement
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) {
      this.stopFollowLoop();
      return;
    }
    const bot = this.bot;
    const target = followTarget(bot, this.follow.player);
    const now = Date.now();

    const decision = decideFollowAction({
      target,
      botPos: bot.entity.position,
      radius: this.follow.radius,
      mode: this.follow.mode,
      lastTpAt: this.follow.lastTpAt,
      now
    });

    // Log "looking for player" at most once per 15s so the console isn't
    // spammed while waiting for someone to log in.
    if (decision.action === 'scan') {
      // The target vanished (logged off / left the loaded area) — release the
      // movement keys so the bot never keeps walking in the last direction.
      this.stopFollowingMovement();
      if (now - this.follow.lastScanLogAt > 15000) {
        this.follow.lastScanLogAt = now;
        this.emitLog('info', `👀 Following "${this.follow.player}" — looking for them in the server…`);
      }
      this.emitFollowStatus('scanning');
      return;
    }

    if (decision.action === 'wait') {
      // Op mode, /tp on cooldown: hold position instead of walking into walls.
      this.stopFollowingMovement();
      this.emitFollowStatus('following', { distance: decision.distance, mode: 'op' });
      return;
    }

    if (decision.action === 'stop') {
      this.stopFollowingMovement();
      this.emitFollowStatus('idle', { distance: decision.distance });
      return;
    }

    if (decision.action === 'tp') {
      this.follow.lastTpAt = now;
      try {
        bot.chat(`/tp ${this.follow.player}`);
        this.emitLog('success', `🪄 Teleported to ${this.follow.player} (op mode)`);
      } catch (_) {
        /* ignore */
      }
      this.emitFollowStatus('following', { distance: decision.distance, mode: 'op' });
      return;
    }

    if (decision.action === 'walk') {
      // Survival: face the player and walk toward them, jumping when a solid
      // block is right in front (simple obstacle hop — no pathfinder needed).
      try {
        bot.lookAt(decision.target.position);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', shouldJumpAhead(bot));
      } catch (_) {
        /* ignore */
      }
      this.emitFollowStatus('following', { distance: decision.distance, mode: 'survival' });
    }
  }

  /** Release forward/sprint/jump controls (stop walking in place). */
  stopFollowingMovement() {
    if (!this.bot) return;
    try {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
    } catch (_) {
      /* ignore */
    }
  }

  /** Push the follow status to the Controls page (throttled to ~1Hz). */
  emitFollowStatus(status, extra = {}) {
    const key = status + (extra.mode ? ':' + extra.mode : '');
    if (key === this.follow.lastStatus && Date.now() - this._lastFollowEmit < 900) return;
    this._lastFollowEmit = Date.now();
    this.follow.lastStatus = key;
    this.emit('follow', {
      status,
      enabled: this.follow.enabled,
      player: this.follow.player,
      mode: this.follow.mode,
      radius: this.follow.radius,
      ...extra
    });
  }

  /* ============================================================
     Guard player (follow + protect)
     ============================================================ */

  /**
   * Guard-player control (Controls page). The bot follows the protected
   * player exactly like Follow, and additionally attacks threats:
   *   - Hostile mobs  -> attacked automatically when within attack range
   *   - Passive mobs  -> attacked only if they hit the bot/player (retaliation)
   *   - Other players -> attacked only if they hit the bot/player (retaliation)
   * Filters are independent toggles: a bucket with its filter off is ignored
   * completely (even retaliation).
   */
  setGuard({ enabled, player, mode, radius, attackRange, hostile, passive, players } = {}) {
    this.guard.enabled = !!enabled;
    this.guard.player = String(player || '').trim();
    this.guard.mode = mode === 'op' ? 'op' : 'survival';
    this.guard.radius = Math.max(1, Math.min(128, Number(radius) || 5));
    this.guard.attackRange = Math.max(2, Math.min(16, Number(attackRange) || 8));
    this.guard.hostile = hostile !== false;
    this.guard.passive = passive !== false;
    this.guard.players = !!players;
    // Guard is the superset of follow — enabling it disables plain follow so
    // the two never fight over the movement keys. Mining is excluded too.
    if (this.guard.enabled) {
      this.stopFollowLoop();
      this.follow.enabled = false;
      this.stopMiningLoop();
      this.mining.enabled = false;
    }
    this.restartGuardLoop();
  }

  /** (Re)start the 1s guard scan — only while connected. */
  restartGuardLoop() {
    this.stopGuardLoop();
    if (!this.guard.enabled) {
      this.emitGuardStatus('off');
      return;
    }
    if (this.state !== 'connected' || !this.bot) {
      this.emitGuardStatus('waiting', { reason: 'Bot is not in a server.' });
      return;
    }
    this.guardTimer = setInterval(() => this.guardTick(), 1000);
    this.guardTimer.unref();
    this.emitGuardStatus('scanning');
    this.guardTick(); // first scan immediately
  }

  /** Stop the guard timer + release any held control states. */
  stopGuardLoop() {
    if (this.guardTimer) {
      clearInterval(this.guardTimer);
      this.guardTimer = null;
    }
    if (this.bot && this.state === 'connected') {
      try {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * One guard scan: (1) follow the protected player like Follow does, and
   * (2) find + attack the nearest threat the filters allow.
   */
  guardTick() {
    if (this.sleepBusy) return; // walking to a bed / sleeping — hands off movement
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) {
      this.stopGuardLoop();
      return;
    }
    const bot = this.bot;
    const now = Date.now();
    const target = this.guard.player ? followTarget(bot, this.guard.player) : null;

    // ---- Movement (same decision logic as Follow) ----
    const move = decideFollowAction({
      target,
      botPos: bot.entity.position,
      radius: this.guard.radius,
      mode: this.guard.mode,
      lastTpAt: this.guard.lastTpAt,
      now
    });
    if (move.action === 'scan' && this.guard.player) {
      this.stopFollowingMovement();
      if (now - this.guard.lastScanLogAt > 15000) {
        this.guard.lastScanLogAt = now;
        this.emitLog('info', `🛡 Guarding "${this.guard.player}" — looking for them in the server…`);
      }
    } else if (move.action === 'stop') {
      this.stopFollowingMovement();
    } else if (move.action === 'tp') {
      this.guard.lastTpAt = now;
      try {
        bot.chat(`/tp ${this.guard.player}`);
        this.emitLog('success', `🪄 Guard teleported to ${this.guard.player} (op mode)`);
      } catch (_) {
        /* ignore */
      }
    } else if (move.action === 'walk') {
      try {
        bot.lookAt(move.target.position);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', shouldJumpAhead(bot));
      } catch (_) {
        /* ignore */
      }
    } else if (move.action === 'wait') {
      this.stopFollowingMovement();
    }

    // ---- Threat scan + attack ----
    const threat = this.findGuardThreat(bot, now);
    if (threat) {
      const lastAt = this.guard.lastAttackAt.get(threat.entity.id) || 0;
      if (now - lastAt >= 1200) {
        this.guard.lastAttackAt.set(threat.entity.id, now);
        try {
          bot.attack(threat.entity);
          this.stats.attacks += 1;
          this.emitLog('warn', `⚔ Guard attacked ${threat.label} (${threat.reason})`);
        } catch (_) {
          /* ignore */
        }
      }
    }

    // Prune old hurt/attack records so the maps never grow unbounded.
    for (const [id, t] of this.guard.hurtBy) if (now - t > 15000) this.guard.hurtBy.delete(id);
    for (const [id, t] of this.guard.lastAttackAt) if (now - t > 10000) this.guard.lastAttackAt.delete(id);

    this.emitGuardStatus(threat ? 'fighting' : target ? (move.action === 'stop' ? 'idle' : 'following') : 'scanning', {
      distance: move.distance,
      threat: threat ? threat.label : null
    });
  }

  /**
   * Find the nearest entity the guard filters allow attacking.
   * Pure classification is delegated to guardThreat() (exported for tests).
   * Returns null when nothing deserves a hit.
   */
  findGuardThreat(bot, now) {
    const me = bot.entity;
    const range = this.guard.attackRange;
    const protectedName = this.guard.player.toLowerCase();
    // On servers that don't tell us who attacked (pre-1.20), we fall back to
    // retaliating against the NEAREST eligible entity within a short window
    // after being hurt by an unknown source.
    const mysteryHurt = now - this.guard.mysteryHurtAt < 8000;
    let best = null;
    let fallback = null;
    const consider = (e, threat, onCooldown) => {
      const dist = me.position.distanceTo(e.position);
      const entry = { entity: e, dist, ...threat };
      if (onCooldown) {
        if (!fallback || dist < fallback.dist) fallback = entry;
        return;
      }
      if (!best || dist < best.dist) best = entry;
    };
    for (const e of Object.values(bot.entities)) {
      if (!e || e === me || !e.position || !e.type) continue;
      // Never attack the protected player or the bot itself.
      if (e.type === 'player' && String(e.username || '').toLowerCase() === protectedName) continue;
      if (String(e.username || '').toLowerCase() === String(bot.username || '').toLowerCase()) continue;
      const dist = me.position.distanceTo(e.position);
      if (dist > range) continue;
      const threat = guardThreat(e, {
        hostile: this.guard.hostile,
        passive: this.guard.passive,
        players: this.guard.players,
        hurtBy: this.guard.hurtBy,
        mysteryHurt,
        now
      });
      if (!threat) continue;
      // Prefer fresh targets: an entity still on the per-target attack
      // cooldown is only used if nothing else is ready to be hit.
      consider(e, threat, now - (this.guard.lastAttackAt.get(e.id) || 0) < 1200);
    }
    return best || fallback;
  }

  /** Push the guard status to the Controls page (throttled to ~1Hz). */
  emitGuardStatus(status, extra = {}) {
    const key = status + (extra.mode ? ':' + extra.mode : '');
    if (key === this.guard.lastStatus && Date.now() - this._lastGuardEmit < 900) return;
    this._lastGuardEmit = Date.now();
    this.guard.lastStatus = key;
    this.emit('guard', {
      status,
      enabled: this.guard.enabled,
      player: this.guard.player,
      mode: this.guard.mode,
      radius: this.guard.radius,
      ...extra
    });
  }

  /* ============================================================
     Sleep / wake (Controls page)
     ============================================================ */

  /**
   * Scan for the nearest bed, walk the bot up to it, and go to sleep.
   * Returns { ok, message } or { ok:false, error }. mineflayer's bot.sleep
   * itself rejects when it is day, the bed is occupied, monsters are nearby
   * or the bot is already sleeping — those errors are surfaced to the user.
   */
  async sleep() {
    if (this.state !== 'connected' || !this.bot) {
      return { ok: false, error: 'Bot is not in a server.' };
    }
    const bot = this.bot;
    if (bot.isSleeping) return { ok: false, error: 'The bot is already sleeping.' };
    if (this.sleepBusy) return { ok: false, error: 'A sleep/walk action is already running.' };
    this.sleepBusy = true;
    // Pause the follow/guard loops so they don't fight for the movement keys
    // while the bot walks to the bed (they re-arm on their own next save / bot
    // restart, and the interval is cleared here).
    this.stopFollowLoop();
    this.stopGuardLoop();

    // Find the nearest bed block within 48 blocks (older MC names it just
    // "bed", modern versions name it by colour like red_bed).
    let bed = null;
    try {
      bed = bot.findBlock({
        matching: (b) => b && /(^|_)bed$/.test(String(b.name || '')),
        maxDistance: 48
      });
    } catch (_) {
      bed = null;
    }
    if (!bed) return { ok: false, error: 'No bed found within 48 blocks of the bot.' };

    this.emitLog('info', `😴 Found a ${bed.name} at ${Math.round(bed.position.x)}, ${Math.round(bed.position.y)}, ${Math.round(bed.position.z)} — walking over…`);

    // Walk within click range (mineflayer needs the bot ~2 blocks from the
    // bed to activate it), then let bot.sleep handle the rest.
    const reached = await this.walkToBed(bed.position, 40000);
    if (!reached) {
      this.sleepBusy = false;
      return { ok: false, error: 'Could not reach the bed (path blocked or timed out).' };
    }

    try {
      await bot.sleep(bed);
      this.emitLog('success', `😴 The bot is now sleeping in the ${bed.name}.`);
      return { ok: true, message: `The bot is now sleeping in a ${bed.name}.` };
    } catch (err) {
      const msg = extractErrorMessage(err);
      this.emitLog('warn', `😴 Could not sleep: ${msg}`);
      return { ok: false, error: msg };
    } finally {
      this.sleepBusy = false;
    }
  }

  /** Wake the bot up (if it is sleeping). */
  async wake() {
    if (this.state !== 'connected' || !this.bot) {
      return { ok: false, error: 'Bot is not in a server.' };
    }
    const bot = this.bot;
    if (!bot.isSleeping) return { ok: false, error: 'The bot is not sleeping.' };
    // Walking to the bed was paused by follow/guard — waking happens in place,
    // so just clear the busy flag if a stale one is set.
    this.sleepBusy = false;
    try {
      await bot.wake();
      this.emitLog('info', '☀️ The bot woke up.');
      return { ok: true, message: 'The bot woke up.' };
    } catch (err) {
      return { ok: false, error: extractErrorMessage(err) };
    }
  }

  /**
   * Walk straight toward a position until within ~2.5 blocks or a timeout.
   * Same simple movement as Follow (look at target + forward + sprint + hop
   * over single blocks). Returns true when close enough.
   */
  async walkToBed(targetPos, timeoutMs) {
    const bot = this.bot;
    const start = Date.now();
    try {
      while (Date.now() - start < timeoutMs) {
        if (this.state !== 'connected' || this.bot !== bot) return false;
        const dist = bot.entity.position.distanceTo(targetPos);
        if (dist <= 2.5) {
          this.stopFollowingMovement();
          return true;
        }
        await bot.lookAt(targetPos);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', shouldJumpAhead(bot));
        await delay(250);
      }
    } catch (_) {
      /* bot disconnected mid-walk */
    }
    this.stopFollowingMovement();
    return false;
  }

  /* ============================================================
     Look at players (Controls page)
     ============================================================ */

  /** Turn the look-at-players toggle on/off. */
  setLook({ enabled } = {}) {
    this.look.enabled = !!enabled;
    this.restartLookLoop();
  }

  /** (Re)start the 1s look loop — only while connected and enabled. */
  restartLookLoop() {
    this.stopLookLoop();
    if (!this.look.enabled) return;
    if (this.state !== 'connected' || !this.bot) return;
    this.lookTimer = setInterval(() => this.lookTick(), 1000);
    this.lookTimer.unref();
  }

  /** Stop the look loop. */
  stopLookLoop() {
    if (this.lookTimer) {
      clearInterval(this.lookTimer);
      this.lookTimer = null;
    }
  }

  /**
   * Look at the nearest player (within 32 blocks) once. Pure head-turn — it
   * never touches the movement keys, so it plays nicely with Follow/Guard and
   * pauses while the bot is walking to a bed / sleeping.
   */
  lookTick() {
    // Follow and Guard already steer the head (and walking direction) toward
    // their target — let them own it. Mining turns the head toward blocks it
    // digs. Look is for idle moments only.
    if (this.follow.enabled || this.guard.enabled || (this.mining && this.mining.enabled)) return;
    if (this.sleepBusy) return;
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) {
      this.stopLookLoop();
      return;
    }
    const bot = this.bot;
    if (bot.isSleeping) return; // no head-turning in bed
    const target = nearestPlayerEntity(bot, 32);
    if (!target) return;
    // lookAt is async — a rejection (bot disconnected mid-look) must not
    // become an unhandled promise rejection.
    bot.lookAt(target.position.offset(0, 1.5, 0)).catch(() => {}); // head height
  }

  /* ============================================================
     Mining (Controls page)
     ============================================================ */

  /**
   * Mining control (Controls page). The bot digs a tunnel ahead of it:
   *   - 'straight' mode: digs the wall at body height (1x2, also clearing
   *     headroom), then walks forward — a straight horizontal tunnel.
   *   - 'stair' mode: digs the wall at feet height AND the block below it,
   *     then steps forward + down — a 1:1 descending staircase.
   * Mining and Follow/Guard are mutually exclusive (all three drive the same
   * movement keys) — enabling one stops the others.
   */
  setMining({ enabled, mode } = {}) {
    this.mining.enabled = !!enabled;
    this.mining.mode = mode === 'stair' ? 'stair' : 'straight';
    if (this.mining.enabled) {
      this.stopFollowLoop();
      this.stopGuardLoop();
      this.follow.enabled = false;
      this.guard.enabled = false;
    }
    this.restartMiningLoop();
  }

  /** (Re)start the self-scheduling mining tick — only while connected. */
  restartMiningLoop() {
    this.stopMiningLoop();
    if (!this.mining.enabled) {
      this.emitMiningStatus('off');
      return;
    }
    if (this.state !== 'connected' || !this.bot) {
      this.emitMiningStatus('waiting', { reason: 'Bot is not in a server.' });
      return;
    }
    this.emitMiningStatus('mining', { blocks: this.mining.blocks });
    this.rescheduleMine();
  }

  /** Stop the mining loop + release any held control states. */
  stopMiningLoop() {
    if (this.mineTimer) {
      clearTimeout(this.mineTimer);
      this.mineTimer = null;
    }
    this.mining.busy = false;
    if (this.bot && this.state === 'connected') {
      try {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
      } catch (_) {
        /* ignore */
      }
    }
  }

  /** Schedule the next mining tick (self-scheduling loop, never overlaps). */
  rescheduleMine() {
    if (!this.mining.enabled || this.state !== 'connected' || !this.bot) return;
    this.mineTimer = setTimeout(() => this.mineTick(), 200);
    if (this.mineTimer && typeof this.mineTimer.unref === 'function') this.mineTimer.unref();
  }

  /**
   * One mining step: dig every target block for the current mode, then step
   * forward into the gap. Self-schedules the next tick when still running.
   */
  async mineTick() {
    if (this.mining.busy) return;
    if (!this.mining.enabled) return;
    if (this.sleepBusy) {
      // Walking to a bed / sleeping — hands off the pickaxe and the keys.
      this.rescheduleMine();
      return;
    }
    if (this.state !== 'connected' || !this.bot || !this.bot.entity) {
      this.stopMiningLoop();
      return;
    }
    const bot = this.bot;
    this.mining.busy = true;
    try {
      const p = bot.entity.position;
      const targets = miningStepTargets({
        x: Math.floor(p.x),
        y: Math.floor(p.y),
        z: Math.floor(p.z),
        yaw: bot.entity.yaw || 0,
        mode: this.mining.mode
      });
      let dug = 0;
      for (const t of targets) {
        if (!this.mining.enabled || this.state !== 'connected' || this.bot !== bot) return;
        const block = bot.blockAt(t);
        // Air, fluids and non-solid blocks aren't diggable — skip silently.
        if (!block || block.boundingBox !== 'block') continue;
        if (block.name === 'bedrock') continue; // never dig unbreakable bedrock
        try {
          await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
          if (!bot.canDigBlock(block)) continue;
          await bot.dig(block);
          dug += 1;
          this.stats.blocksMined += 1;
          this.mining.blocks += 1;
        } catch (_) {
          /* block changed / can't reach — move on */
        }
      }
      if (dug) {
        if (Date.now() - this.mining.lastLogAt > 8000) {
          this.mining.lastLogAt = Date.now();
          this.emitLog('success', `⛏ Mining ${this.mining.mode} — ${this.mining.blocks} blocks broken so far.`);
        }
        this.emitMiningStatus('mining', { blocks: this.mining.blocks });
      } else {
        // Nothing left to dig — walk forward into the opening (falling down
        // one block in stair mode).
        await this.mineStepForward(bot);
        this.emitMiningStatus('mining', { blocks: this.mining.blocks });
      }
    } catch (_) {
      /* bot disconnected mid-step */
    } finally {
      this.mining.busy = false;
      this.rescheduleMine();
    }
  }

  /**
   * Walk the bot forward ~1 block (or into the next stair step).
   * Stops early once the bot has actually advanced a block (or descended in
   * stair mode) so it never sprints past the dug gap — the next wall is where
   * the next dig begins.
   */
  async mineStepForward(bot) {
    const p0 = bot.entity.position;
    const yaw = bot.entity.yaw || 0;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const isStair = this.mining.mode === 'stair';
    const maxMs = isStair ? 700 : 500;
    const started = Date.now();
    try {
      await bot.lookAt({ x: p0.x + dx * 1.2, y: p0.y, z: p0.z + dz * 1.2 });
      bot.setControlState('forward', true);
      if (!isStair) bot.setControlState('sprint', true); // walk, don't sprint, into a stair step
      bot.setControlState('jump', shouldJumpAhead(bot));
      while (Date.now() - started < maxMs && this.state === 'connected' && this.bot === bot && this.mining.enabled) {
        const p = bot.entity.position;
        const horiz = Math.hypot(p.x - p0.x, p.z - p0.z);
        if (horiz >= 1.0 || p0.y - p.y >= 0.6) break; // moved ~1 block (or dropped a step) — stop
        await delay(60);
      }
    } catch (_) {
      /* ignore */
    } finally {
      this.stopFollowingMovement();
    }
  }

  /** Push the mining status to the Controls page (throttled to ~1Hz). */
  emitMiningStatus(status, extra = {}) {
    if (status === this.mining.lastStatus && Date.now() - this._lastMineEmit < 900) return;
    this._lastMineEmit = Date.now();
    this.mining.lastStatus = status;
    this.emit('mining', {
      status,
      enabled: this.mining.enabled,
      mode: this.mining.mode,
      blocks: this.mining.blocks,
      ...extra
    });
  }

  /**
   * tossStack clicks window slots, which are relative to bot.currentWindow.
   * If a container (chest, etc.) is open, its slot indexes won't match the
   * player inventory — close it first so drops hit the right items.
   */
  closeOpenContainer() {
    const bot = this.bot;
    if (!bot || !bot.currentWindow || bot.currentWindow === bot.inventory) return;
    try {
      bot.closeWindow(bot.currentWindow);
    } catch (_) {
      /* ignore */
    }
  }

  /** Reconnect to the last used server (if any). */
  reconnect() {
    if (!this.config) {
      this.emitLog('warn', 'Nothing to reconnect to — save your settings first.');
      return;
    }
    this.emitLog('info', 'Reconnecting…');
    this.start(this.config);
  }

  handleError(err) {
    this.lastError = extractErrorMessage(err);
    this.state = 'error';
    this.emitLog('error', this.lastError);
    this.emit('state', this.snapshot());
  }

  emitLog(level, message) {
    const entry = { level, message, time: Date.now() };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.MAX_LOG_LINES) {
      this.logBuffer = this.logBuffer.slice(-this.MAX_LOG_LINES);
    }
    this.emit('log', entry);
  }

  /** Full state snapshot sent to dashboard clients. */
  snapshot() {
    return {
      state: this.state,
      // Always surface the configured server (name/ip/port/version) so a
      // stopped bot still lets the top bar show the saved settings — never
      // rely on the socket layer having separately delivered config:loaded.
      config: this.config || loadConfig(),
      lastError: this.lastError,
      hasConnected: this.hasConnected,
      canReconnect: this.hasConnected || this.state !== 'stopped',
      latencyMs: this.latencyMs
    };
  }

  destroy() {
    this.stop(true);
    this.removeAllListeners();
  }
}

/**
 * Decide which auth command (if any) to send for a server chat message.
 * Pure + exported so the logic is unit-testable without a live bot.
 *
 * Only treats a message as a prompt when it clearly looks like an auth
 * message (contains "/login", "/register", "password", "please" or
 * "authme") — so a player casually saying "login" in chat does NOT make
 * the bot reply, and "You are already logged in!" is ignored on its own
 * (killing the retry loop). Returns { command, type } or null.
 */
function decideAuthCommand(message, { password, sentLogin = false, sentRegister = false } = {}) {
  const pw = String(password || '').trim();
  if (!pw) return null;

  const text = String(message || '').toLowerCase();
  const looksAuth = ['/login', '/register', 'password', 'please', 'authme'].some((k) => text.includes(k));
  if (!looksAuth) return null;

  // Guards are independent so a message that mentions BOTH words (e.g.
  // "You are already registered! Please login with /login <password>") still
  // falls through to the login branch once register is already done.
  if (text.includes('register') && !sentRegister) {
    return { command: `/register ${pw} ${pw}`, type: 'register' };
  }
  if (/\blogin\b|\blog in\b/.test(text) && !sentLogin) {
    return { command: `/login ${pw}`, type: 'login' };
  }
  return null;
}

/**
 * Turn any thrown value into a human-readable message.
 * Node's AggregateError (e.g. connect failures) wraps the real causes in
 * `.errors` — unwrap to the first meaningful one so the dashboard shows
 * something like "connect ECONNREFUSED 127.0.0.1:25565" instead of
 * just "AggregateError".
 */
function extractErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (Array.isArray(err.errors) && err.errors.length) {
    return extractErrorMessage(err.errors[0]);
  }
  if (typeof err.message === 'string' && err.message.trim()) {
    return err.message;
  }
  return String(err);
}

/* ============================================================
   Follow-player decision logic (pure + exported for tests)
   ------------------------------------------------------------
   decideFollowAction returns one of:
     { action: 'scan'  }  target player not found yet — keep looking
     { action: 'stop', distance }  target within radius — stay put
     { action: 'tp',   distance }  op mode, target beyond radius — /tp them
     { action: 'wait', distance }  op mode, /tp on cooldown — hold position
     { action: 'walk', distance, target }  survival — walk toward them
   ============================================================ */

/**
 * Find the nearest player entity (excluding the bot itself) within a radius.
 * Pure + exported so the look-at logic is unit-testable. Returns the entity
 * or null. Only horizontal distance counts (matching how the eye tracks).
 */
function nearestPlayerEntity(bot, radius = 32) {
  if (!bot || !bot.entities || !bot.entity) return null;
  const me = bot.entity;
  const meName = String(bot.username || '').toLowerCase();
  const r2 = radius * radius;
  let nearest = null;
  let best = r2;
  for (const e of Object.values(bot.entities)) {
    if (!e || e === me || e.type !== 'player' || !e.position) continue;
    if (String(e.username || '').toLowerCase() === meName) continue;
    const dx = e.position.x - me.position.x;
    const dz = e.position.z - me.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      nearest = e;
    }
  }
  return nearest;
}

/** Find the player entity with the given username (case-insensitive). */
function followTarget(bot, player) {
  const name = String(player || '').trim().toLowerCase();
  if (!name || !bot || !bot.entities) return null;
  for (const e of Object.values(bot.entities)) {
    if (!e || e.type !== 'player' || !e.username) continue;
    if (String(e.username).toLowerCase() === name) return e;
  }
  return null;
}

/**
 * Decide what the follow loop should do this tick.
 * Pure — takes plain position objects so it can be tested without a bot.
 * Returns one of: scan | stop | tp | wait | walk (see class docs above).
 */
function decideFollowAction({ target, botPos, radius, mode, lastTpAt, now }) {
  if (!target || !target.position || !botPos) return { action: 'scan' };
  const dist = Math.round(target.position.distanceTo(botPos) * 10) / 10;
  const r = Math.max(1, Math.min(128, Number(radius) || 5));
  if (dist <= r) return { action: 'stop', distance: dist };
  if (mode === 'op') {
    // Throttle /tp to once per 2.5s so a far-away target doesn't spam the
    // server chat with teleport commands every second. During the cooldown
    // the bot holds position ('wait') rather than walking into walls.
    if (now - (lastTpAt || 0) >= 2500) return { action: 'tp', distance: dist };
    return { action: 'wait', distance: dist };
  }
  return { action: 'walk', distance: dist, target };
}

/**
 * Survival obstacle hop: should the bot jump right now?
 * True when there is a solid block at the bot's feet level directly in the
 * direction it is facing (within ~1.5 blocks).
 */
function shouldJumpAhead(bot) {
  try {
    const p = bot.entity.position;
    const yaw = bot.entity.yaw;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const b = bot.blockAt({ x: p.x + dx * 1.5, y: p.y, z: p.z + dz * 1.5 });
    return !!(b && b.boundingBox === 'block');
  } catch (_) {
    return false;
  }
}

/* ============================================================
   Mining step targets (pure + exported for tests)
   ------------------------------------------------------------
   The blocks a single mining step should dig, for a bot standing at a
   block position (x, y, z) facing `yaw`, in the given mode:
     - 'straight' -> the wall at body height AND the block above it (a
       classic 1x2 tunnel: clears headroom so the bot never gets stuck).
     - 'stair'    -> the wall at feet height AND the block below it (the
       step the bot walks into, descending exactly 1 block per step).
   Returns an array of {x, y, z} block positions (empty never happens —
   there is always a block one step ahead).
   ============================================================ */
function miningStepTargets({ x, y, z, yaw, mode }) {
  const dx = -Math.sin(yaw || 0);
  const dz = -Math.cos(yaw || 0);
  const fx = Math.floor(x + dx);
  const fz = Math.floor(z + dz);
  if (mode === 'stair') {
    return [
      { x: fx, y, z: fz },
      { x: fx, y: y - 1, z: fz }
    ];
  }
  return [
    { x: fx, y, z: fz },
    { x: fx, y: y + 1, z: fz }
  ];
}

/* ============================================================
   Guard threat classification (pure + exported for tests)
   ------------------------------------------------------------
   guardThreat(entity, filters) decides whether a nearby entity
   deserves an attack, based on the entity bucket and the filter
   toggles:
     - 'hostile' mob (entity.kind === 'Hostile mobs') -> attack
       automatically when the filter is on.
     - 'passive' mob / other mob -> attack ONLY in retaliation
       (it hit the bot or the protected player) and only when
       the passive filter is on.
     - 'player' -> attack ONLY in retaliation and only when the
       players filter is on.
   Returns { reason, label } or null.
   ============================================================ */

/** Bucket an entity: 'hostile' | 'passive' | 'player' | null (ignored). */
function guardBucket(entity) {
  if (!entity) return null;
  if (entity.type === 'player') return 'player';
  if (entity.type === 'mob') {
    return entity.kind === 'Hostile mobs' ? 'hostile' : 'passive';
  }
  return null; // objects / projectiles / unknown kinds are never attacked
}

/**
 * Decide whether `entity` is a guard target.
 * `hurtBy` is a Map(entityId -> timestamp) of entities that recently hit the
 * bot or the protected player (filled from the entityHurt event).
 * `mysteryHurt` is the pre-1.20 fallback: the bot was hurt by an unknown
 * attacker, so any eligible (filter-on) retaliation entity counts.
 */
function guardThreat(entity, { hostile, passive, players, hurtBy, mysteryHurt = false, now }) {
  const bucket = guardBucket(entity);
  if (!bucket) return null;
  const label = entity.username || entity.displayName || entity.name || 'entity';

  if (bucket === 'hostile') {
    return hostile ? { reason: 'hostile', label } : null;
  }
  const filterOn = bucket === 'player' ? players : passive;
  if (!filterOn) return null;
  const hitAt = hurtBy.get(entity.id);
  if (typeof hitAt === 'number' && now - hitAt <= 12000) {
    return { reason: 'attacked', label };
  }
  // Unknown-attacker fallback: only for retaliation buckets, and only while
  // the mystery window is still open.
  if (mysteryHurt) return { reason: 'attacked', label };
  return null;
}



/* ============================================================
   Terrain surface extraction (2D map live layer)
   ------------------------------------------------------------
   For each 16x16 chunk column we find the topmost "opaque" block and map
   its state id onto a small terrain palette (0 = none/transparent). The
   palette keeps the socket payload tiny: one character per block column.

   Transparent vegetation (grass, flowers…) is skipped so the block beneath
   shows — a tall grass on grass_block still renders green, a cactus on
   sand still renders sandy.
   ============================================================ */

/** Terrain palette indices (1-char codes in encodeTerrainChunk). */
const TERRAIN_CHARS = '0123456789ABC';

/**
 * Map a block state id onto the terrain palette index.
 * Pure + exported so the classification is unit-testable.
 * Returns 0 for air / transparent vegetation (caller should scan deeper).
 */
function classifySurfaceBlock(stateId, blocksByStateId) {
  if (!blocksByStateId || !blocksByStateId[stateId]) return 0;
  const name = blocksByStateId[stateId].name || '';
  if (!name) return 0;
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return 0;

  // Transparent / non-solid vegetation — skip, show what's beneath.
  if (
    /^(tall_grass|short_grass|grass|fern|large_fern|dead_bush|sugar_cane|bamboo|cactus|sweet_berry_bush|kelp|kelp_plant|seagrass|tall_seagrass|vine|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|glow_lichen|chorus_plant|chorus_flower|nether_wart|torchflower|pitcher_plant|wheat|carrots|potatoes|beetroots|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|cocoa)$/.test(name) ||
    /^(poppy|dandelion|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower_crop)$/.test(name) ||
    /^(oak_sapling|spruce_sapling|birch_sapling|jungle_sapling|acacia_sapling|dark_oak_sapling|mangrove_propagule|cherry_sapling|azalea|flowering_azalea|moss_carpet)$/.test(name)
  ) {
    return 0;
  }

  if (name.startsWith('water')) return 1;
  if (name.startsWith('lava')) return 2;
  if (name === 'sand' || name === 'red_sand' || name.endsWith('sandstone') || name === 'gravel') {
    return name === 'gravel' ? 7 : 3;
  }
  if (name === 'grass_block' || name === 'grass' || name === 'moss_block' || name === 'muddy_mangrove_roots') {
    return 4;
  }
  if (
    name === 'dirt' || name === 'coarse_dirt' || name === 'rooted_dirt' || name === 'podzol' ||
    name === 'mud' || name === 'mycelium' || name === 'farmland' || name === 'dirt_path'
  ) {
    return 5;
  }
  if (
    name.endsWith('_ore') ||
    name === 'stone' || name === 'cobblestone' || name === 'deepslate' || name === 'cobbled_deepslate' ||
    name === 'bedrock' || name === 'granite' || name === 'diorite' || name === 'andesite' ||
    name === 'tuff' || name === 'calcite' || name === 'dripstone_block' || name === 'obsidian' ||
    name === 'crying_obsidian' || name === 'blackstone' || name === 'basalt' || name === 'polished_basalt' ||
    name === 'smooth_basalt' || name === 'end_stone' || name === 'nether_bricks' || name === 'red_nether_bricks' ||
    name === 'bricks' || name === 'stone_bricks' || name === 'cracked_stone_bricks' ||
    name === 'mossy_stone_bricks' || name.endsWith('_bricks') || name.endsWith('_brick')
  ) {
    return 6;
  }
  if (name.startsWith('snow') || name.endsWith('ice') || name === 'frosted_ice' || name === 'powder_snow') {
    return 8;
  }
  if (name.endsWith('_leaves')) return 9;
  if (name.endsWith('_log') || name.endsWith('_wood') || name.endsWith('_hyphae') || name.endsWith('_planks') || name === 'mangrove_roots' || name === 'bamboo_block') {
    return 10;
  }
  if (name === 'netherrack' || name === 'soul_sand' || name === 'soul_soil' || name === 'crimson_nylium' ||
    name === 'warped_nylium' || name === 'shroomlight' || name === 'nether_wart_block' || name === 'warped_wart_block' ||
    name === 'magma_block' || name === 'glowstone'
  ) {
    return 11;
  }
  return 12; // other solid
}

/**
 * Compute the surface palette for a whole 16x16 chunk column.
 * Fast path: top-down through non-empty sections (works for both the
 * sparse 1.18+ sections array and the object-keyed older formats).
 * Fallback: per-column getBlockStateId scan for exotic chunk layouts.
 * Returns a Uint8Array(256) of palette indices (z*16+x).
 */
function computeChunkSurface(chunk, blocksByStateId) {
  const out = new Uint8Array(256);
  let sections = null;
  if (Array.isArray(chunk.sections)) {
    sections = chunk.sections
      .map((s, i) => ({ s, i }))
      .filter((e) => e.s)
      .sort((a, b) => b.i - a.i);
  } else if (chunk.sections && typeof chunk.sections === 'object') {
    sections = Object.keys(chunk.sections)
      .map((k) => ({ s: chunk.sections[k], i: Number(k) }))
      .sort((a, b) => b.i - a.i);
  }

  // Section-level block readers vary by MC era: 1.8 sections use
  // getBlockStateId(pos), 1.9–1.17 use getBlock(pos), 1.18+ use get(pos).
  // All take a {x,y,z} position object — never a flat index.
  let read = null;
  let fastFlat = false;
  if (sections && sections.length) {
    for (const { s } of sections) {
      // 1.18+ palette sections: flat data.get(index) == get(pos) but
      // avoids building a position object per read — much faster.
      if (s && s.data && typeof s.data.get === 'function' && typeof s.get === 'function') {
        fastFlat = true;
        read = (sec, x, y, z) => sec.data.get((y << 8) | (z << 4) | x);
        break;
      }
      if (typeof s.getBlock === 'function') {
        read = (sec, x, y, z) => sec.getBlock({ x, y, z });
        break;
      }
      if (typeof s.get === 'function') {
        read = (sec, x, y, z) => sec.get({ x, y, z });
        break;
      }
      if (typeof s.getBlockStateId === 'function') {
        read = (sec, x, y, z) => sec.getBlockStateId({ x, y, z });
        break;
      }
    }
  }

  if (read) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let idx = 0;
        for (const { s } of sections) {
          // All-air sections (1.18+ palette sections track a solid-block
          // count) are skipped in O(1) — no column scan needed.
          if (s && s.solidBlockCount === 0) continue;
          let id = 0;
          for (let ry = 15; ry >= 0; ry--) {
            const v = read(s, x, ry, z);
            if (v !== 0) { id = v; break; }
          }
          if (id) {
            idx = classifySurfaceBlock(id, blocksByStateId);
            if (idx !== 0) break; // found the visible surface
          }
        }
        out[z * 16 + x] = idx;
      }
    }
  } else {
    const maxY = typeof chunk.worldHeight === 'number' ? chunk.worldHeight - 1 : 255;
    const minY = typeof chunk.minY === 'number' ? chunk.minY : 0;
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let idx = 0;
        for (let y = maxY; y >= minY; y--) {
          const v = chunk.getBlockStateId({ x, y, z });
          if (v !== 0) {
            idx = classifySurfaceBlock(v, blocksByStateId);
            if (idx !== 0) break;
          }
        }
        out[z * 16 + x] = idx;
      }
    }
  }
  return out;
}

/** Encode a surface Uint8Array into a compact string (1 char per column). */
function encodeTerrainChunk(surface) {
  let out = '';
  for (let i = 0; i < 256; i++) out += TERRAIN_CHARS[surface[i]];
  return out;
}

module.exports = { BotManager, decideAuthCommand, classifySurfaceBlock, computeChunkSurface, encodeTerrainChunk, followTarget, decideFollowAction, shouldJumpAhead, guardBucket, guardThreat, nearestPlayerEntity, miningStepTargets };
