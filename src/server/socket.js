'use strict';

const { loadConfig, saveConfig, configExists, addServerHistory, removeServerHistory } = require('../config/store');
const { getSupportedVersions } = require('../constants/versions');

// Throttle bot restarts globally (across all clients/sockets) so a
// misbehaving or rapid-clicking client can't spawn an endless churn of
// Mineflayer sessions.
const MIN_START_INTERVAL_MS = 2000;
let lastStartAt = 0;

/**
 * Wires Socket.io to the BotManager.
 *
 * Server → client:  bot:state, bot:log, bot:logs, config:loaded, config:updated
 * Client → server:  config:save, bot:start, bot:stop, bot:reconnect
 */
function registerSocketHandlers(io, botManager, socketAuth) {
  // Only authenticated clients may connect (session cookie required).
  if (socketAuth) io.use(socketAuth);

  // Push bot state + logs + viewer state + inventory to every connected client.
  botManager.on('state', (snapshot) => io.emit('bot:state', snapshot));
  botManager.on('log', (entry) => io.emit('bot:log', entry));
  botManager.on('inventory', (snapshot) => io.emit('inventory', snapshot));
  botManager.viewer.on('state', (snapshot) => io.emit('viewer:state', snapshot));

  // 2D radar — streamed every second while the bot is in a server.
  const radarTimer = setInterval(() => {
    const radar = botManager.getRadar();
    if (radar) io.emit('bot:radar', radar);
  }, 1000);
  radarTimer.unref();

  // Live terrain — streamed on its own faster cadence so the 2D map fills
  // in a few seconds instead of ~15 (refreshTerrain has a per-tick time
  // budget and only emits when chunks actually changed).
  const terrainTimer = setInterval(() => {
    const terrain = botManager.refreshTerrain();
    if (terrain) io.emit('bot:terrain', terrain);
  }, 400);
  terrainTimer.unref();

  // Bot + server statistics — streamed every 2 seconds.
  const serverStats = () => {
    const mem = process.memoryUsage();
    return {
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal }
    };
  };
  const statsTimer = setInterval(() => {
    io.emit('bot:stats', botManager.getStats());
    io.emit('server:stats', serverStats());
  }, 2000);
  statsTimer.unref();

  io.on('connection', (socket) => {
    console.log(`[socket] client connected: ${socket.id}`);

    // Bring a freshly connected client up to speed.
    socket.emit('bot:state', botManager.snapshot());
    socket.emit('bot:logs', botManager.logBuffer);
    socket.emit('config:loaded', loadConfig());
    socket.emit('viewer:state', botManager.viewer.snapshot());
    socket.emit('inventory', botManager.getInventory());
    socket.emit('inventory:settings', inventorySettings(loadConfig()));
    socket.emit('bot:radar', botManager.getRadar());
    socket.emit('bot:stats', botManager.getStats());
    socket.emit('server:stats', serverStats());

    // Bring the terrain up to date too. The terrain cache lives server-side
    // and is normally only pushed as deltas (on the 400ms timer), so without
    // this a fresh page load would show an EMPTY map until the bot moved.
    // Send a reset first (clears any stale tiles from a previous session),
    // then the full cached snapshot.
    socket.emit('bot:terrain', { type: 'reset' });
    const terrainSnap = botManager.getTerrainSnapshot();
    if (terrainSnap) socket.emit('bot:terrain', terrainSnap);

    socket.on('disconnect', () => {
      console.log(`[socket] client disconnected: ${socket.id}`);
    });

    // ---- Client → Server actions ----

    socket.on('config:save', (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const result = validateConfig(data);
      if (!result.ok) return respond(ack, { ok: false, errors: result.errors });
      const saved = saveConfig(result.value);
      const history = addServerHistory({ ip: saved.serverIp, port: saved.serverPort, version: saved.version });
      io.emit('config:updated', saved);
      io.emit('config:history', history);
      respond(ack, { ok: true, config: saved, history });
    });

    socket.on('config:history:remove', (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = removeServerHistory(d.ip, d.port);
      if (!result.ok) return respond(ack, { ok: false, errors: [result.error] });
      io.emit('config:history', result.history);
      respond(ack, { ok: true, history: result.history });
    });

    socket.on('bot:start', (data, ack) => {
      const now = Date.now();
      if (now - lastStartAt < MIN_START_INTERVAL_MS) {
        return respond(ack, { ok: false, errors: ['Please wait a moment before starting the bot again.'] });
      }
      lastStartAt = now;
      const user = socket.data.user;
      if (user && user.role === 'admin') {
        // Admin: use (and persist) the values from the form.
        const result = validateConfig(data);
        if (!result.ok) return respond(ack, { ok: false, errors: result.errors });
        const saved = saveConfig(result.value);
        const history = addServerHistory({ ip: saved.serverIp, port: saved.serverPort, version: saved.version });
        io.emit('config:history', history);
        botManager.start(result.value);
      } else {
        // Guest: may only START the bot, always with the admin-configured
        // server (ignores whatever the form contains).
        if (!configExists()) {
          return respond(ack, {
            ok: false,
            errors: ['No server configured yet. An admin must save bot settings first.']
          });
        }
        botManager.start(loadConfig());
      }
      respond(ack, { ok: true });
    });

    // Normalize the ack: socket.io appends the callback as the LAST argument,
    // so `socket.emit('ev', cb)` and `socket.emit('ev', data, cb)` land it in
    // different slots. Accepting (data, ack) and falling back when the first
    // slot holds the callback keeps every client call shape working.
    socket.on('bot:reconnect', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      botManager.reconnect();
      respond(ack, { ok: true });
    });

    socket.on('bot:stop', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      botManager.stop();
      respond(ack, { ok: true });
    });

    // Send a chat message / server command as the bot (any signed-in user).
    socket.on('bot:chat', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const d = data && typeof data === 'object' ? data : {};
      const message = String(d.message || '').trim();
      if (!message) return respond(ack, { ok: false, errors: ['Message is empty.'] });
      if (message.length > 256) return respond(ack, { ok: false, errors: ['Message is too long (max 256 chars).'] });
      if (!botManager.sendChat(message)) {
        return respond(ack, { ok: false, errors: ['Bot is not in a server — start it first.'] });
      }
      respond(ack, { ok: true, message });
    });

    // ---- Inventory actions (admin only) ----

    socket.on('inventory:dropAll', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      botManager
        .dropAll()
        .then((res) => respond(ack, res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => respond(ack, { ok: false, errors: [extractErr(err)] }));
    });

    socket.on('inventory:drop', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      botManager
        .dropItem(d.name, d.count)
        .then((res) => respond(ack, res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => respond(ack, { ok: false, errors: [extractErr(err)] }));
    });

    socket.on('inventory:move', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      botManager
        .moveItem(d.fromSlot, d.toSlot)
        .then((res) => respond(ack, res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => respond(ack, { ok: false, errors: [extractErr(err)] }));
    });

    socket.on('inventory:get', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const snap = botManager.getInventory();
      // Always answer so the client can tell "no bot" from "stale push".
      respond(ack, { ok: true, snapshot: snap });
      if (snap) socket.emit('inventory', snap);
    });

    socket.on('inventory:equip', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      botManager
        .equipItem(d.slot)
        .then((res) => respond(ack, res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => respond(ack, { ok: false, errors: [extractErr(err)] }));
    });

    socket.on('inventory:settings', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = validateInventorySettings(d);
      if (!result.ok) return respond(ack, { ok: false, errors: result.errors });
      const saved = saveConfig({
        autoDropEnabled: result.value.autoDropEnabled,
        autoDropItem: result.value.autoDropItem,
        autoEatEnabled: result.value.autoEatEnabled,
        autoEatThreshold: result.value.autoEatThreshold,
        autoToolEnabled: result.value.autoToolEnabled,
        autoArmorEnabled: result.value.autoArmorEnabled
      });
      botManager.setAutoDrop({ enabled: saved.autoDropEnabled, itemName: saved.autoDropItem });
      botManager.setAutoEat({ enabled: saved.autoEatEnabled, threshold: saved.autoEatThreshold });
      botManager.setAutoTool({ enabled: saved.autoToolEnabled });
      botManager.setAutoArmor({ enabled: saved.autoArmorEnabled });
      io.emit('inventory:settings', inventorySettings(saved));
      respond(ack, { ok: true, settings: inventorySettings(saved) });
    });
  });
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function isAdmin(socket) {
  return socket.data && socket.data.user && socket.data.user.role === 'admin';
}

/** Validate + normalize config coming from the dashboard form. */
function validateConfig(data = {}) {
  const errors = [];

  const botName = String(data.botName || '').trim();
  if (!botName) errors.push('Bot name is required.');
  else if (botName.length > 32) errors.push('Bot name must be 32 characters or fewer.');

  const serverIp = String(data.serverIp || '').trim();
  if (!serverIp) errors.push('Server IP is required.');

  const serverPort = Number(data.serverPort);
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    errors.push('Port must be a number between 1 and 65535.');
  }

  const version = String(data.version || '').trim();
  if (!getSupportedVersions().includes(version)) {
    errors.push(`Unsupported Minecraft version "${version}".`);
  }

  // Inventory helpers (auto-drop / auto-eat). Fields that callers don't
  // send (e.g. the dashboard form, which has no inventory controls) fall
  // back to the CURRENT persisted values — never clobber them with defaults.
  const existingCfg = loadConfig();
  const autoDropEnabled = data.autoDropEnabled === undefined ? !!existingCfg.autoDropEnabled : !!data.autoDropEnabled;
  const autoDropItem = data.autoDropItem === undefined
    ? String(existingCfg.autoDropItem || '').trim()
    : String(data.autoDropItem).trim();
  const autoEatEnabled = data.autoEatEnabled === undefined ? !!existingCfg.autoEatEnabled : !!data.autoEatEnabled;
  const rawEat = data.autoEatThreshold === undefined || data.autoEatThreshold === null
    ? (existingCfg.autoEatThreshold !== undefined ? existingCfg.autoEatThreshold : 10)
    : data.autoEatThreshold;
  const autoEatThreshold = rawEat === '' ? 10 : Number(rawEat);
  const autoToolEnabled = data.autoToolEnabled === undefined ? !!existingCfg.autoToolEnabled : !!data.autoToolEnabled;
  const autoArmorEnabled = data.autoArmorEnabled === undefined ? !!existingCfg.autoArmorEnabled : !!data.autoArmorEnabled;
  if (autoDropItem.length > 64) errors.push('Auto-drop item name is too long.');
  if (!Number.isInteger(autoEatThreshold) || autoEatThreshold < 1 || autoEatThreshold > 19) {
    errors.push('Auto-eat threshold must be a number between 1 and 19.');
  }

  // Server login system (AuthMe-style plugins). Missing fields default safely
  // so older clients / callers that don't send them still validate fine.
  const loginEnabled = !!data.loginEnabled;
  const loginPassword = String(data.loginPassword || '').trim();
  const loginAutoDetect = !!data.loginAutoDetect;
  const rawDelay = data.loginDelaySeconds;
  const loginDelaySeconds = rawDelay === undefined || rawDelay === null || rawDelay === '' ? 5 : Number(rawDelay);
  if (loginEnabled && loginPassword.length < 4) {
    errors.push('Login password must be at least 4 characters when the login system is on.');
  }
  if (!Number.isInteger(loginDelaySeconds) || loginDelaySeconds < 1 || loginDelaySeconds > 60) {
    errors.push('Retry delay must be a number between 1 and 60 seconds.');
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      botName,
      serverIp,
      serverPort,
      version,
      auth: 'offline',
      loginEnabled,
      loginPassword,
      loginAutoDetect,
      loginDelaySeconds,
      autoDropEnabled,
      autoDropItem,
      autoEatEnabled,
      autoEatThreshold,
      autoToolEnabled,
      autoArmorEnabled
    }
  };
}

/** Normalize the inventory-helper settings for the client. */
function inventorySettings(cfg) {
  return {
    autoDropEnabled: !!cfg.autoDropEnabled,
    autoDropItem: String(cfg.autoDropItem || ''),
    autoEatEnabled: !!cfg.autoEatEnabled,
    autoEatThreshold: Number(cfg.autoEatThreshold) || 10,
    autoToolEnabled: !!cfg.autoToolEnabled,
    autoArmorEnabled: !!cfg.autoArmorEnabled
  };
}

/** Validate the inventory-helper settings from the Inventory page. */
function validateInventorySettings(data = {}) {
  const errors = [];
  const autoDropEnabled = !!data.autoDropEnabled;
  const autoDropItem = String(data.autoDropItem || '').trim();
  const autoEatEnabled = !!data.autoEatEnabled;
  const rawEat = data.autoEatThreshold;
  const autoEatThreshold = rawEat === undefined || rawEat === null || rawEat === '' ? 10 : Number(rawEat);
  const autoToolEnabled = !!data.autoToolEnabled;
  const autoArmorEnabled = !!data.autoArmorEnabled;
  if (autoDropEnabled && !autoDropItem) errors.push('Pick an item name to auto-drop.');
  if (autoDropItem.length > 64) errors.push('Auto-drop item name is too long.');
  if (!Number.isInteger(autoEatThreshold) || autoEatThreshold < 1 || autoEatThreshold > 19) {
    errors.push('Auto-eat threshold must be a number between 1 and 19.');
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { autoDropEnabled, autoDropItem, autoEatEnabled, autoEatThreshold, autoToolEnabled, autoArmorEnabled } };
}

/** Turn any thrown value into a readable message. */
function extractErr(err) {
  if (!err) return 'Unknown error';
  return typeof err.message === 'string' && err.message.trim() ? err.message : String(err);
}

module.exports = { registerSocketHandlers, validateConfig };
