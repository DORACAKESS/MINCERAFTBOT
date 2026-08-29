'use strict';

/* ============================================================
   Building — build executor
   ------------------------------------------------------------
   Turns a parsed build (see parser.js) into blocks placed in the
   live Minecraft world by the bot. Three modes:

     survival  — place blocks from the bot's inventory; when the
                 bot is short on materials, pull from a chest
                 (exact coordinates or the nearest one nearby).
     creative  — place directly; if a material is missing, try to
                 /give it to the bot (needs operator).
     operator  — build with /setblock + /fill commands (no block
                 physics), and "give items" /gives every material.

   Exact block states: every block parsed from a schematic/litematic
   keeps its properties (facing / half / axis / open …). Operator
   mode serialises them into /setblock descriptors so the result
   matches the file exactly. Survival/creative use physics placement
   with a best-effort facing look, then the VERIFY pass fixes any
   deviation via /setblock (creative/operator) or re-placement.

   Verify-after-build: after placement the builder scans every block
   with bot.blockAt, compares name + properties, reports issues,
   fixes them and re-verifies — repeating until clean or the max
   number of passes is reached (verify.passes).

   Speed: the per-block delay is configurable (options.speed, ms),
   from the dashboard speed presets (🐢 Slow → ⚡ Turbo).

   Placement strategy (survival + creative):
     - blocks are processed bottom-up so each layer has support;
     - for each block we find a reference block (below, then any
       already-placed neighbour), equip the item and placeBlock;
     - unreachable / unsupported blocks are skipped and reported.

   Safety:
     - one build at a time (startBuild rejects while busy);
     - the bot must stay connected — the build aborts on disconnect;
     - a cancel flag (stopBuild) is checked between every block;
     - a block cap (MAX_BLOCKS) stops absurdly large builds.

   Pure helpers (materialRequirements, missingFromInventory, mergeRuns,
   blockDescriptor, propsMatch) are exported so the decision logic is
   unit-testable without a bot.
   ============================================================ */

const { EventEmitter } = require('events');

const { SKIP_NAMES } = require('./parser');
const { snbt } = require('./snbt');

const MAX_BLOCKS = 50000;
const CHEST_NAMES = new Set(['chest', 'trapped_chest', 'barrel']);
const DEFAULT_DELAY = 160; // ms per block at "Normal" speed
const MIN_DELAY = 5;
const MAX_DELAY = 5000;
const DEFAULT_VERIFY_PASSES = 3;
const MAX_CMD_NBT = 200; // commands via chat are capped ~256 chars — keep NBT small
// Wall-attached blocks: buttons, levers, wall signs/torches/banners, ladders,
// tripwire hooks, chains? (no). Their `facing` points at the wall they sit on.
const WALL_ATTACH_RE = /(_button|_wall_sign|_wall_banner|_wall_torch|_torch|tripwire_hook|lever|ladder|_wall_head|_wall_skull)$/;
// Double-height blocks whose upper half is auto-placed with the lower one.
const DOUBLE_BLOCK_RE = /_door$|_bed$|_trapdoor$/;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================
   Pure helpers
   ============================================================ */

/** Material requirements: Map name -> total count needed (non-air). */
function materialRequirements(blocks) {
  const need = new Map();
  for (const b of blocks || []) {
    if (!b || SKIP_NAMES.has(b.name)) continue;
    need.set(b.name, (need.get(b.name) || 0) + 1);
  }
  return need;
}

/**
 * Which materials the bot is short on, given its inventory items.
 * inventoryItems: [{ name, count }]. Returns Map name -> missing count.
 */
function missingFromInventory(need, inventoryItems) {
  const have = new Map();
  for (const it of inventoryItems || []) {
    if (!it || !it.name) continue;
    have.set(it.name, (have.get(it.name) || 0) + (Number(it.count) || 1));
  }
  const missing = new Map();
  for (const [name, count] of need) {
    const avail = have.get(name) || 0;
    if (avail < count) missing.set(name, count - avail);
  }
  return missing;
}

/**
 * Serialise a block into a Minecraft /setblock descriptor, keeping its
 * exact state: `minecraft:oak_stairs[facing=east,half=bottom]` (name is
 * stripped of the minecraft: prefix for 1.13+ servers, which accept
 * either form). Blocks without properties serialize to the bare name.
 * Pure + exported for tests.
 */
function blockDescriptor(name, properties) {
  const clean = String(name || 'unknown').replace(/^minecraft:/, '');
  const props = properties && typeof properties === 'object' ? properties : null;
  if (!props) return clean;
  // Sort keys so identical states always serialize identically, no matter
  // the order the palette/registry happened to hand them to us in — this
  // keeps /fill run-merging reliable across different sources.
  const parts = [];
  for (const k of Object.keys(props).sort()) {
    const v = props[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${v}`);
  }
  return parts.length ? `${clean}[${parts.join(',')}]` : clean;
}

/**
 * Do two property sets agree? The expectation may omit cosmetic states
 * (e.g. waterlogged) — a missing key in the expectation is ignored, and
 * a missing key in the actual is a mismatch only if the expectation had
 * a non-default value for it. Pure + exported for tests.
 */
function propsMatch(expected, actual) {
  if (!expected || typeof expected !== 'object' || !Object.keys(expected).length) return true;
  const act = (actual && typeof actual === 'object') ? actual : {};
  for (const [k, v] of Object.entries(expected)) {
    if (v === undefined || v === null) continue;
    if (act[k] === undefined || String(act[k]) !== String(v)) return false;
  }
  return true;
}

/**
 * Merge a block list into /fill + /setblock commands for operator mode.
 * Blocks that share a row (same y + z), the same descriptor (name +
 * properties) and are contiguous along x are merged into one /fill
 * command — walls and floors become a handful of commands instead of
 * thousands of /setblock calls. Pure + exported for tests.
 */
function mergeRuns(blocks, origin = { x: 0, y: 0, z: 0 }) {
  const cmds = [];
  // Sort bottom-up, then row-major (y, then z, then x).
  const sorted = [...(blocks || [])].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y;
    if (a.z !== b.z) return a.z - b.z;
    return a.x - b.x;
  });
  let i = 0;
  while (i < sorted.length) {
    const b = sorted[i];
    // Skip non-placeable names in op mode too (structure_void etc.)
    if (!b || SKIP_NAMES.has(b.name)) { i++; continue; }
    const desc = blockDescriptor(b.name, b.properties);
    let j = i + 1;
    while (
      j < sorted.length &&
      blockDescriptor(sorted[j].name, sorted[j].properties) === desc &&
      sorted[j].y === b.y &&
      sorted[j].z === b.z &&
      sorted[j].x === sorted[j - 1].x + 1
    ) {
      j++;
    }
    const ax = origin.x + b.x;
    const ay = origin.y + b.y;
    const az = origin.z + b.z;
    const bx = origin.x + sorted[j - 1].x;
    if (j - i > 1) {
      cmds.push(`/fill ${ax} ${ay} ${az} ${bx} ${ay} ${az} ${desc} replace`);
    } else {
      cmds.push(`/setblock ${ax} ${ay} ${az} ${desc}`);
    }
    i = j;
  }
  return cmds;
}

/* ============================================================
   Builder
   ============================================================ */

function createBuilder({ getBotManager, store }) {
  const emitter = new EventEmitter();
  let active = null; // { id, cancel }

  function isBuilding() {
    return !!active;
  }

  function progress(payload) {
    emitter.emit('progress', { ...payload, buildId: active ? active.id : null });
  }

  /** Cancel any running build. Safe to call when nothing is running. */
  function stopBuild() {
    if (active) active.cancel = true;
  }

  /** Log a line through the bot manager (shows on the Console page). */
  function log(level, message) {
    try {
      const bm = getBotManager();
      if (bm && typeof bm.emitLog === 'function') bm.emitLog(level, `[Building] ${message}`);
    } catch (_) { /* ignore */ }
  }

  function connected() {
    const bm = getBotManager();
    return !!(bm && bm.state === 'connected' && bm.bot);
  }

  /**
   * Start building. options:
   *   { id, mode: 'survival'|'creative'|'operator',
   *     origin: {x,y,z},
   *     chest: { enabled, pos: {x,y,z}|null, findNearest },
   *     speed: ms per block (optional, defaults to Normal),
   *     verify: { enabled, passes } }
   * Resolves { ok } or { ok:false, error }. Progress streams via
   * 'progress' events on the emitter. Completion via 'done'.
   */
  async function startBuild(options) {
    const opts = options || {};
    if (active) return { ok: false, error: 'A build is already running — stop it first.' };
    if (!connected()) return { ok: false, error: 'The bot is not in a server — start it first.' };

    const entry = store.get(opts.id);
    if (!entry) return { ok: false, error: 'Build not found.' };
    const buf = store.readFile(opts.id);
    if (!buf) return { ok: false, error: 'Build file is missing on disk.' };

    const mode = ['survival', 'creative', 'operator'].includes(opts.mode) ? opts.mode : 'survival';
    const origin = {
      x: Math.floor(Number(opts.origin && opts.origin.x)) || 0,
      y: Math.floor(Number(opts.origin && opts.origin.y)) || 0,
      z: Math.floor(Number(opts.origin && opts.origin.z)) || 0
    };
    const speed = Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.floor(Number(opts.speed)) || DEFAULT_DELAY));
    const verify = (opts.verify && opts.verify.enabled) ? {
      passes: Math.max(1, Math.min(10, Math.floor(Number(opts.verify.passes)) || DEFAULT_VERIFY_PASSES))
    } : null;

    let parsed;
    try {
      const { parseBuild } = require('./parser');
      parsed = await parseBuild(buf, entry.fileName);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log('error', `Could not parse "${entry.name}": ${msg}`);
      return { ok: false, error: `Could not parse the file: ${msg}` };
    }

    const blocks = (parsed.blocks || []).filter((b) => b && !SKIP_NAMES.has(b.name));
    if (!blocks.length) return { ok: false, error: 'The build contains no placeable blocks.' };
    if (blocks.length > MAX_BLOCKS) {
      return { ok: false, error: `Too many blocks (${blocks.length.toLocaleString()} — max ${MAX_BLOCKS.toLocaleString()}).` };
    }

    // Attach block-entity NBT (sign text, chest contents, banner patterns …)
    // to their blocks so every mode can reproduce them exactly.
    const beByPos = new Map();
    for (const be of parsed.blockEntities || []) {
      beByPos.set(`${be.x},${be.y},${be.z}`, be);
    }
    for (const b of blocks) {
      const be = beByPos.get(`${b.x},${b.y},${b.z}`);
      if (be) b.blockEntity = be;
    }
    const entities = (parsed.entities || []).filter((e) => e && e.id);

    const job = { id: opts.id, cancel: false, mode, origin, speed, verify, entities, chestOptions: (opts.chest && opts.chest.enabled) ? opts.chest : {} };
    active = job;
    progress({
      phase: 'started',
      total: blocks.length,
      message: `${entry.name} · ${blocks.length.toLocaleString()} blocks${entities.length ? ` + ${entities.length} entity${entities.length === 1 ? '' : 's'}` : ''} · ${mode} mode`
    });
    log('info', `Starting build "${entry.name}" (${mode}) at ${origin.x} ${origin.y} ${origin.z}`);

    try {
      if (mode === 'operator') {
        await runOperator(job, entry, parsed, blocks, origin);
      } else {
        await runPlace(job, entry, blocks, origin, mode, opts.chest);
      }
      // Spawn entities (paintings, item frames, armor stands) — commands only.
      if (!job.cancel && job.entities.length && mode !== 'survival') {
        await spawnEntities(job, origin, mode);
      }
      // Verify + fix loop (skipped when stopped or when verification disabled).
      const verifyResult = (!job.cancel && job.verify) ? await runVerify(job, blocks, origin, mode) : null;
      if (!job.cancel) {
        const placed = job.placed || 0;
        const skipped = job.skipped || 0;
        const fixed = (verifyResult && verifyResult.fixed) || 0;
        let msg = 'Build finished.';
        let extra = '';
        if (verifyResult) {
          if (verifyResult.ok) {
            msg = `Build verified clean (${verifyResult.passes} pass${verifyResult.passes === 1 ? '' : 'es'}, ${fixed} block${fixed === 1 ? '' : 's'} fixed).`;
          } else {
            msg = `Build finished — ${verifyResult.remaining} issue${verifyResult.remaining === 1 ? '' : 's'} still need fixing after ${verifyResult.passes} passes.`;
          }
          extra = ` · verify: ${verifyResult.ok ? 'clean' : verifyResult.remaining + ' remaining'}`;
        }
        progress({ phase: 'done', placed, skipped, fixed, total: blocks.length, message: msg });
        log('success', `Build "${entry.name}" finished (${placed.toLocaleString()} placed, ${skipped.toLocaleString()} skipped${extra}).`);
        emitter.emit('done', { buildId: opts.id, ok: true, placed, skipped, fixed, verify: verifyResult });
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      progress({ phase: 'error', message: msg });
      log('error', `Build "${entry.name}" failed: ${msg}`);
      emitter.emit('done', { buildId: opts.id, ok: false, error: msg });
    } finally {
      active = null;
    }
    return { ok: true };
  }

  /** Operator mode: /fill + /setblock commands (exact states + NBT), throttled. */
  async function runOperator(job, entry, parsed, blocks, origin) {
    const bm = getBotManager();
    // Blocks WITH block-entity NBT must be /setblock'd individually (the NBT
    // rides on the command) — only plain blocks get /fill run-merging.
    const plain = blocks.filter((b) => !b.blockEntity);
    const nbt = blocks.filter((b) => b.blockEntity);
    const cmds = mergeRuns(plain, origin);
    for (const b of nbt) {
      const cmd = setblockNbtCommand(b, origin);
      if (cmd) cmds.push(cmd);
    }
    const total = cmds.length;
    progress({ phase: 'running', placed: 0, total, message: `${total.toLocaleString()} commands (${blocks.length.toLocaleString()} blocks, ${nbt.length} with NBT)` });
    log('info', `Operator build: ${cmds.length} commands (${nbt.length} carry block-entity NBT)`);

    for (let i = 0; i < cmds.length; i++) {
      if (job.cancel) {
        progress({ phase: 'stopped', placed: i, total, message: 'Build stopped by user.' });
        log('warn', 'Build stopped by user.');
        return;
      }
      if (!connected()) throw new Error('Bot disconnected mid-build.');
      // A block with oversized NBT yields "setblock\ndata merge" — split and
      // send each as its own chat command (a newline in one message breaks it).
      const parts = String(cmds[i]).split('\n').filter(Boolean);
      for (const part of parts) bm.sendChat(part);
      job.placed = i + 1;
      if ((i + 1) % 20 === 0 || i + 1 === total) {
        progress({ phase: 'running', placed: i + 1, total, message: `${i + 1}/${total} commands` });
      }
      // Throttle chat commands — too fast = server kicks / drops them.
      // Chat is always paced at a safe floor even on ⚡ Turbo.
      await delay(commandDelay(job));
    }
  }

  /**
   * /setblock for a block carrying block-entity NBT (sign text, chest items,
   * banner patterns …). If the NBT would blow the chat command length limit
   * we fall back to a plain /setblock (no NBT) + a separate /data merge,
   * which also carries the NBT.
   */
  function setblockNbtCommand(block, origin) {
    const name = String(block.name || '').replace(/^minecraft:/, '');
    if (!name) return null;
    const x = origin.x + (block.x || 0);
    const y = origin.y + (block.y || 0);
    const z = origin.z + (block.z || 0);
    const state = blockDescriptor(name, block.properties);
    const nbt = block.blockEntity && block.blockEntity.data ? snbt(block.blockEntity.data) : '';
    const base = `/setblock ${x} ${y} ${z} ${state}`;
    if (!nbt) return base;
    const full = `${base} ${nbt}`;
    if (full.length <= 256) return full;
    // Oversized NBT: place the block, then /data merge the NBT on top.
    return `${base}\n/data merge block ${x} ${y} ${z} ${nbt}`;
  }

  /** Spawn entities (paintings, item frames, armor stands) via /summon. */
  async function spawnEntities(job, origin, mode) {
    const bm = getBotManager();
    for (let i = 0; i < job.entities.length; i++) {
      if (job.cancel) return;
      if (!connected()) throw new Error('Bot disconnected mid-build.');
      const e = job.entities[i];
      const id = String(e.id).replace(/^minecraft:/, '');
      const x = (origin.x + (e.x || 0)).toFixed(2);
      const y = (origin.y + (e.y || 0)).toFixed(2);
      const z = (origin.z + (e.z || 0)).toFixed(2);
      const nbt = e.data ? snbt(e.data) : '';
      const cmd = `/summon minecraft:${id} ${x} ${y} ${z} ${nbt}`.trim();
      bm.sendChat(cmd);
      log('info', `Summoned ${id} at ${x} ${y} ${z}`);
      job.placed = (job.placed || 0) + 1;
      if ((i + 1) % 5 === 0 || i + 1 === job.entities.length) {
        progress({ phase: 'running', placed: job.placed, total: job.entities.length, message: `Entities ${i + 1}/${job.entities.length} summoned` });
      }
      await delay(commandDelay(job));
    }
  }

  /** Survival / creative: place block-by-block with support checks. */
  async function runPlace(job, entry, blocks, origin, mode, chestOpts) {
    const bm = getBotManager();
    const bot = bm.bot;
    const need = materialRequirements(blocks);
    const items = bot.inventory.items();

    // Pre-flight: the bot must be able to REACH the build site for
    // placement (placeBlock works within a few blocks). Warn instead of
    // silently skipping every block.
    try {
      const p = bot.entity && bot.entity.position;
      const dist = p ? Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) : Infinity;
      if (dist > 8) {
        log('warn', `Origin is ${Math.round(dist)} blocks away — place the bot closer (within ~8 blocks) or blocks will be skipped.`);
        progress({ phase: 'running', placed: 0, skipped: 0, total: blocks.length, message: `⚠ Bot is ${Math.round(dist)} blocks from the origin — move it closer!` });
      }
    } catch (_) { /* ignore */ }

    // Creative auto-gives missing materials (needs operator).
    if (mode === 'creative') {
      const missing = missingFromInventory(need, items);
      for (const [name, count] of missing) {
        if (job.cancel || !connected()) return;
        bm.sendChat(`/give ${bot.username} ${name} ${count}`);
        log('info', `Creative: gave ${count} × ${name}`);
        await delay(commandDelay(job));
      }
    }

    // Survival: pull missing materials from a chest when enabled.
    if (mode === 'survival' && chestOpts && chestOpts.enabled) {
      await pullFromChest(job, need);
    }

    // Bottom-up so each block has support from below. Double-height blocks
    // (doors, beds) auto-place their upper half, so the schematic's second
    // block for them is skipped by the name check below.
    const ordered = [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
    const total = ordered.length;
    job.placed = 0;
    job.skipped = 0;
    const placedAt = new Set(); // "x,y,z" of blocks we placed (for side support)
    const placedSigns = []; // { block, text } — updateSign after placement

    for (const block of ordered) {
      if (job.cancel) {
        progress({ phase: 'stopped', placed: job.placed, skipped: job.skipped, total, message: 'Build stopped by user.' });
        log('warn', 'Build stopped by user.');
        return;
      }
      if (!connected()) throw new Error('Bot disconnected mid-build.');

      const tx = origin.x + block.x;
      const ty = origin.y + block.y;
      const tz = origin.z + block.z;

      try {
        const target = bot.blockAt({ x: tx, y: ty, z: tz });
        // Skip if the target is already the right block or not placeable.
        if (target && (target.name === block.name || !target.boundingBox)) {
          job.skipped++;
          continue;
        }
        const ref = findReference(bot, tx, ty, tz, block);
        if (!ref) {
          job.skipped++;
          continue;
        }

        const item = bot.inventory.items().find((i) => i && i.name === block.name && i.count > 0);
        if (!item) {
          // Creative was supposed to give it; survival without chest -> skip.
          job.skipped++;
          continue;
        }

        await bot.equip(item, 'hand');
        await bot.lookAt(ref.pos, true);
        // Best-effort orientation: face the block's desired direction so
        // stairs / logs / furnaces place facing correctly in survival.
        lookForFacing(bot, block, ref.pos);
        await bot.placeBlock(ref.block, ref.face);
        placedAt.add(`${tx},${ty},${tz}`);
        job.placed++;
        // Creative is operator-level: re-set the block with its exact NBT so
        // sign glow, chest contents and banner patterns are reproduced.
        if (mode === 'creative' && block.blockEntity) {
          const cmd = setblockNbtCommand(block, origin);
          if (cmd) {
            for (const c of String(cmd).split('\n').filter(Boolean)) bm.sendChat(c);
          }
        }
        // Sign text: remember the placed block so we can write its lines
        // (survival + creative fallback when the server lacks op for NBT).
        const signText = blockSignText(block);
        if (signText) placedSigns.push({ pos: { x: tx, y: ty, z: tz }, text: signText });
        // Chest contents (survival): fill what the bot actually has.
        if (mode === 'survival' && block.blockEntity && /chest|barrel|trapped_chest/.test(block.name)) {
          await fillChest(job, bot, { x: tx, y: ty, z: tz }, block.blockEntity);
        }
      } catch (_) {
        job.skipped++;
      }

      if ((job.placed + job.skipped) % 10 === 0 || job.placed + job.skipped === total) {
        progress({
          phase: 'running',
          placed: job.placed,
          skipped: job.skipped,
          total,
          message: `${job.placed}/${total} placed` + (job.skipped ? ` · ${job.skipped} skipped` : '')
        });
      }
      await delay(job.speed);
    }

    // Write sign text (update_sign packet — works in survival/creative).
    for (const s of placedSigns) {
      if (job.cancel || !connected()) return;
      try {
        const blk = bot.blockAt(s.pos);
        if (blk && blk.name && /sign/.test(blk.name)) {
          bot.updateSign(blk, s.text);
          log('info', `Sign at ${s.pos.x} ${s.pos.y} ${s.pos.z}: "${s.text.split('\n').filter(Boolean).join(' | ')}"`);
        }
      } catch (_) { /* server may reject — best effort */ }
      await delay(job.speed);
    }
  }

  /**
   * Verify-after-build: scan every block with bot.blockAt, compare name +
   * properties, fix mismatches, re-verify — until clean or `job.verify.passes`
   * passes. Returns { ok, passes, fixed, remaining }.
   */
  async function runVerify(job, blocks, origin, mode) {
    const bm = getBotManager();
    const bot = bm.bot;
    const maxPasses = job.verify.passes;
    const total = blocks.length;
    let fixed = 0;
    let remaining = 0;
    let pass = 0;

    do {
      pass++;
      let issues = [];
      progress({ phase: 'verify', placed: 0, total, message: `Verify pass ${pass} — scanning…` });
      log('info', `Verify pass ${pass}/${maxPasses} — scanning ${total.toLocaleString()} blocks.`);

      for (let i = 0; i < blocks.length; i++) {
        if (job.cancel) {
          progress({ phase: 'stopped', placed: i, total, message: 'Verify stopped by user.' });
          return { ok: false, stopped: true, passes: pass, fixed, remaining: issues.length };
        }
        if (!connected()) throw new Error('Bot disconnected mid-verify.');
        const b = blocks[i];
        const tx = origin.x + b.x;
        const ty = origin.y + b.y;
        const tz = origin.z + b.z;
        let actual = null;
        try { actual = bot.blockAt({ x: tx, y: ty, z: tz }); } catch (_) { /* treat as air */ }
        const nameOk = actual && actual.name === b.name;
        const propsOk = nameOk && propsMatch(b.properties, actual && (actual.getProperties ? actual.getProperties() : actual.properties));
        if (!nameOk || !propsOk) {
          issues.push({ x: tx, y: ty, z: tz, name: b.name, properties: b.properties, blockEntity: b.blockEntity, actual: actual ? actual.name : 'air' });
        }
        if ((i + 1) % 25 === 0 || i + 1 === total) {
          progress({ phase: 'verify', placed: i + 1, total, message: `Verify pass ${pass} — ${i + 1}/${total} · ${issues.length} issue${issues.length === 1 ? '' : 's'}` });
        }
        // Scanning is cheap (local world read); stay fast so big builds verify quickly.
        if (job.speed > 60) await delay(Math.min(8, job.speed / 20));
      }

      if (!issues.length) {
        remaining = 0;
        progress({ phase: 'verified', placed: total, total, fixed, message: `✅ Verified clean — every block matches (${pass} pass${pass === 1 ? '' : 'es'}).` });
        log('success', `Verify pass ${pass}: 0 issues — build is exact (${fixed} block${fixed === 1 ? '' : 's'} fixed).`);
        return { ok: true, passes: pass, fixed, remaining: 0 };
      }

      remaining = issues.length;
      log('warn', `Verify pass ${pass}: ${issues.length} issue(s) — fixing (${mode} mode).`);
      progress({ phase: 'fixing', placed: 0, total: issues.length, message: `Fixing ${issues.length} issue(s)…` });

      for (let i = 0; i < issues.length; i++) {
        if (job.cancel) {
          progress({ phase: 'stopped', placed: i, total: issues.length, message: 'Verify stopped by user.' });
          return { ok: false, stopped: true, passes: pass, fixed, remaining: issues.length - i };
        }
        if (!connected()) throw new Error('Bot disconnected mid-verify.');
        const m = issues[i];
        if (await placeExact(job, bot, m.x, m.y, m.z, m.name, m.properties, mode, m)) fixed++;
        if ((i + 1) % 10 === 0 || i + 1 === issues.length) {
          progress({ phase: 'fixing', placed: i + 1, total: issues.length, message: `Fixed ${i + 1}/${issues.length} issue(s)…` });
        }
        await delay(mode === 'operator' || (mode === 'creative' && m.properties && Object.keys(m.properties).length) ? commandDelay(job) : job.speed);
      }
    } while (pass < maxPasses);

    progress({ phase: 'verify-failed', placed: total, total, fixed, message: `⚠ ${remaining} issue(s) still need fixing after ${pass} passes.` });
    log('warn', `Verify finished with ${remaining} unresolved issue(s) after ${pass} passes.`);
    return { ok: false, passes: pass, fixed, remaining };
  }

  /**
   * Place ONE block exactly at a coordinate. Used by the verify fix pass:
   *   - operator:   /setblock with the exact descriptor (name + properties)
   *   - creative:   /setblock too (bot is op — /give already needs it) so the
   *                 state is exact; falls back to physics if the block has no
   *                 properties
   *   - survival:   physics placement with best-effort facing look
   * Returns true when a placement was attempted successfully.
   */
  async function placeExact(job, bot, tx, ty, tz, name, properties, mode, block) {
    try {
      const withNbt = block && block.blockEntity && block.blockEntity.data;
      // Operator (and creative when the state must be exact / carries NBT):
      // /setblock with the descriptor (+ NBT when present).
      if (mode === 'operator' || ((mode === 'creative') && (withNbt || (properties && Object.keys(properties).length)))) {
        const cmd = withNbt
          ? setblockNbtCommand({ name, properties, blockEntity: block.blockEntity, x: tx - (job.origin ? job.origin.x : 0), y: ty - (job.origin ? job.origin.y : 0), z: tz - (job.origin ? job.origin.z : 0) }, { x: 0, y: 0, z: 0 })
          : `/setblock ${tx} ${ty} ${tz} ${blockDescriptor(name, properties)}`;
        const parts = String(cmd).split('\n');
        for (const c of parts) getBotManager().sendChat(c);
        // Sign text via NBT already applied for signs carrying it.
        return true;
      }
      // Survival (or creative for plain blocks): physical placement. If a
      // wrong block is already there (name or state mismatch), dig it out
      // first — placeBlock can't overwrite an occupied block.
      const target = bot.blockAt({ x: tx, y: ty, z: tz });
      if (target && target.name !== 'air' && (target.name !== name || !propsMatch(properties, target.getProperties ? target.getProperties() : target.properties))) {
        if (!target.boundingBox) return false; // unbreakable (bedrock etc.)
        await bot.dig(target);
      }
      const ref = findReference(bot, tx, ty, tz, { name, properties });
      if (!ref) return false;
      const item = bot.inventory.items().find((i) => i && i.name === name && i.count > 0);
      if (!item) return false;
      await bot.equip(item, 'hand');
      await bot.lookAt(ref.pos, true);
      lookForFacing(bot, { name, properties }, ref.pos);
      await bot.placeBlock(ref.block, ref.face);
      // Sign text after physical placement.
      const signText = block && block.blockEntity ? blockSignText(block) : null;
      if (signText) {
        const blk = bot.blockAt({ x: tx, y: ty, z: tz });
        if (blk && /sign/.test(blk.name)) bot.updateSign(blk, signText);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Open a chest (coords or nearest) and move needed materials to the bot. */
  async function pullFromChest(job, need) {
    const bm = getBotManager();
    const bot = bm.bot;
    const missing = missingFromInventory(need, bot.inventory.items());
    if (!missing.size) return;

    let chest = null;
    const chestOpts = job.chestOptions || {};
    if (chestOpts.pos && chestOpts.pos.x !== undefined) {
      chest = bot.blockAt({ x: chestOpts.pos.x, y: chestOpts.pos.y, z: chestOpts.pos.z });
    } else {
      chest = bot.findBlock({
        matching: (b) => b && CHEST_NAMES.has(b.name),
        maxDistance: chestOpts.findNearest ? 32 : 12
      });
    }
    if (!chest) {
      log('warn', 'Chest supply enabled but no chest found — building with inventory only.');
      return;
    }

    let window;
    try {
      window = await bot.openContainer(chest);
      // Only pull what's missing, in bulk. window.deposit(itemType, metadata,
      // count) takes the item NAME as a string and resolves undefined on
      // success (throws when the item isn't there) — re-check after each
      // pull so partial deposits still make progress.
      for (const [name, count] of missing) {
        if (job.cancel) break;
        const before = countInInventory(bot, name);
        const take = Math.min(count, 512);
        try {
          await window.deposit(name, null, take);
          const after = countInInventory(bot, name);
          const pulled = after - before;
          if (pulled > 0) log('info', `Chest: pulled ${pulled} × ${name}`);
        } catch (_) {
          /* item not in chest / deposit failed — keep going */
        }
      }
    } catch (err) {
      log('warn', `Chest could not be opened: ${err.message}`);
    } finally {
      try {
        if (window) window.close();
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Find a block to place against.
   * - Wall-attached blocks (buttons, levers, wall signs/torches/banners,
   *   ladders) place against the WALL their `facing` points at, so they
   *   attach correctly instead of floating.
   * - Everything else prefers below, then any placed neighbour.
   */
  function findReference(bot, tx, ty, tz, block) {
    const props = (block && block.properties) || {};
    if (props.facing && WALL_ATTACH_RE.test(String(block.name || ''))) {
      const wallRef = wallAttachRef(props.facing);
      if (wallRef) {
        const wall = bot.blockAt({ x: tx + wallRef.wallDx, y: ty, z: tz + wallRef.wallDz });
        if (wall && wall.boundingBox === 'block' && wall.name !== 'air') {
          return { block: wall, pos: wall.position, face: wallRef.face };
        }
      }
    }
    const candidates = [
      { dx: 0, dy: -1, dz: 0, face: { x: 0, y: 1, z: 0 } },
      { dx: 1, dy: 0, dz: 0, face: { x: -1, y: 0, z: 0 } },
      { dx: -1, dy: 0, dz: 0, face: { x: 1, y: 0, z: 0 } },
      { dx: 0, dy: 0, dz: 1, face: { x: 0, y: 0, z: -1 } },
      { dx: 0, dy: 0, dz: -1, face: { x: 0, y: 0, z: 1 } }
    ];
    for (const c of candidates) {
      const b = bot.blockAt({ x: tx + c.dx, y: ty + c.dy, z: tz + c.dz });
      if (b && b.boundingBox === 'block' && b.name !== 'air') {
        return { block: b, pos: b.position, face: c.face };
      }
    }
    return null;
  }

  /**
   * Fill a just-placed chest/barrel from its block-entity Items NBT.
   * Best effort: only items the bot actually holds are deposited.
   */
  async function fillChest(job, bot, pos, blockEntity) {
    try {
      const items = blockEntity.data && blockEntity.data.value && blockEntity.data.value.Items;
      const list = (items && items.value && items.value.value) || [];
      if (!list.length) return;
      const block = bot.blockAt(pos);
      if (!block || !/chest|barrel|trapped_chest/.test(block.name)) return;
      const window = await bot.openContainer(block);
      try {
        for (const it of list) {
          if (job.cancel) break;
          const iv = it.value || it;
          const id = String((iv.id && iv.id.value) || (iv.id) || '').replace(/^minecraft:/, '');
          const count = Number((iv.Count && iv.Count.value) ?? iv.Count ?? 1) || 1;
          if (!id) continue;
          const inInv = countInInventory(bot, id);
          if (inInv <= 0) continue;
          const take = Math.min(count, inInv, 64);
          try {
            await window.deposit(id, null, take);
            log('info', `Chest at ${pos.x} ${pos.y} ${pos.z}: +${take} × ${id}`);
          } catch (_) { /* stack slots full / not found — keep going */ }
        }
      } finally {
        try { window.close(); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      log('warn', `Could not fill container at ${pos.x} ${pos.y} ${pos.z}: ${err.message}`);
    }
  }

  /**
   * Best-effort orientation for physics placement: turn the bot toward the
   * block's desired facing (stairs / logs / furnaces orient by the player's
   * look direction when placed).
   */
  function lookForFacing(bot, block, from) {
    try {
      const props = (block && block.properties) || {};
      let facing = props.facing;
      if (!facing && props.axis) {
        // Logs / pillars: axis maps to the facing the bot looks along.
        if (props.axis === 'x') facing = 'east';
        else if (props.axis === 'z') facing = 'south';
        else return; // vertical axis — placement does it
      }
      if (!facing) return;
      // MC yaw: south = 0, west = 90, north = 180, east = -90.
      const yaw = { south: 0, west: Math.PI / 2, north: Math.PI, east: -Math.PI / 2 }[facing];
      if (yaw === undefined) return;
      const pitch = Math.atan2(from.y - bot.entity.position.y, Math.hypot(from.x - bot.entity.position.x, from.z - bot.entity.position.z));
      bot.look(yaw, pitch, true);
    } catch (_) { /* ignore */ }
  }

  /**
   * Operator-only: give every material to the bot (/give).
   * Used by the "Get items" button on the Building page.
   */
  async function giveItems(id) {
    if (active) return { ok: false, error: 'A build is running — stop it first.' };
    if (!connected()) return { ok: false, error: 'The bot is not in a server — start it first.' };
    const entry = store.get(id);
    if (!entry) return { ok: false, error: 'Build not found.' };
    const materials = entry.materials || [];
    if (!materials.length) return { ok: false, error: 'This build has no materials listed.' };

    const bm = getBotManager();
    const bot = bm.bot;
    log('info', `Giving ${materials.length} material types to ${bot.username}…`);
    for (const m of materials) {
      if (!connected()) return { ok: false, error: 'Bot disconnected mid-give.' };
      bm.sendChat(`/give ${bot.username} ${m.name} ${m.count}`);
      await delay(160);
    }
    log('success', `Gave ${materials.length} material types to ${bot.username}.`);
    return { ok: true, materials: materials.length };
  }

  return { startBuild, stopBuild, isBuilding, giveItems, on: (e, cb) => emitter.on(e, cb), emitter };
}

/**
 * Safe delay for CHAT commands (/setblock, /fill, /give). Even on ⚡ Turbo
 * the bot never spams commands faster than this floor, so operators and
 * creative builds can't get chat-rate kicked. Physics placement (placeBlock)
 * is not chat — it keeps the raw speed the user picked.
 */
const CHAT_FLOOR_MS = 150;
function commandDelay(job) {
  return Math.max(job.speed, CHAT_FLOOR_MS);
}

/**
 * Wall-attachment reference for a block with a horizontal `facing`.
 * A button facing EAST sits on the WEST side of its wall (the wall is at
 * target - 1 on the facing axis) and we click the wall's EAST face (+x) so
 * the button ends up facing east. Pure + exported for tests.
 * Returns { wallDx, wallDz, face } or null when `facing` isn't horizontal.
 */
function wallAttachRef(facing) {
  const map = {
    north: { wallDx: 0, wallDz: 1, face: { x: 0, y: 0, z: -1 } }, // wall behind (south), click its north face
    south: { wallDx: 0, wallDz: -1, face: { x: 0, y: 0, z: 1 } },
    west: { wallDx: 1, wallDz: 0, face: { x: -1, y: 0, z: 0 } },
    east: { wallDx: -1, wallDz: 0, face: { x: 1, y: 0, z: 0 } }
  };
  return map[facing] || null;
}

/**
 * Extract sign text lines from a block's block-entity NBT.
 * Handles 1.20.2+ front_text.messages and 1.13-1.20 Text1..Text4.
 * Returns a newline-joined string (updateSign accepts one), or null.
 * Pure + exported for tests.
 */
function blockSignText(block) {
  if (!block || !block.blockEntity || !block.blockEntity.data) return null;
  const d = block.blockEntity.data;
  // front_text.messages is a list of JSON strings: ["\"{\\"text\\":\"hi\"}\""]
  const front = d.value && d.value.front_text && d.value.front_text.value;
  if (front) {
    const msgs = front.messages && front.messages.value;
    const raw = (msgs && msgs.value) || [];
    const lines = raw.map((t) => decodeSignLine(t));
    if (lines.some((l) => l)) return lines.join('\n').replace(/\n+$/, '');
  }
  // Legacy Text1..Text4 (byte/string per line).
  const legacy = [];
  for (let i = 1; i <= 4; i++) {
    const node = d.value && d.value['Text' + i];
    if (!node) break;
    const t = node.value;
    legacy.push(decodeSignLine(t));
  }
  if (legacy.some((l) => l)) return legacy.join('\n').replace(/\n+$/, '');
  return null;
}

/** Turn a sign line's JSON-encoded text component into plain text. */
function decodeSignLine(raw) {
  try {
    let s = String(raw || '');
    // Prismarine-nbt may hand back the string already unquoted.
    if (s.startsWith('\"')) {
      try { s = JSON.parse(s); } catch (_) { s = s.replace(/^\"|\"$/g, ''); }
    }
    if (!s) return '';
    // Plain text (not a JSON text component) passes through as-is.
    if (s[0] !== '{' && s[0] !== '[') return s;
    const comp = JSON.parse(s);
    if (typeof comp === 'string') return comp;
    if (comp && typeof comp.text === 'string') return comp.text;
    return '';
  } catch (_) {
    return '';
  }
}

/** Total count of an item name in the bot's inventory. */
function countInInventory(bot, name) {
  try {
    return (bot.inventory.items() || []).reduce((n, i) => n + (i && i.name === name ? (i.count || 1) : 0), 0);
  } catch (_) {
    return 0;
  }
}

module.exports = {
  createBuilder,
  materialRequirements,
  missingFromInventory,
  mergeRuns,
  blockDescriptor,
  propsMatch,
  blockSignText,
  decodeSignLine,
  wallAttachRef,
  countInInventory,
  CHEST_NAMES,
  SKIP_NAMES,
  MAX_BLOCKS,
  DEFAULT_DELAY,
  DEFAULT_VERIFY_PASSES,
  CHAT_FLOOR_MS,
  commandDelay
};
