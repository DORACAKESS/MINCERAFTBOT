'use strict';

/* ============================================================
   MineBot — Controls page socket handlers
   Client -> server:  controls:get, controls:save
   Server -> client:  controls:config, controls:updated, controls:status
   ============================================================ */

const { loadConfig, saveConfig } = require('../config/store');

/** Normalized follow settings shape sent to the client. */
function followSettings(cfg) {
  return {
    enabled: !!cfg.followEnabled,
    player: String(cfg.followPlayer || ''),
    mode: cfg.followMode === 'op' ? 'op' : 'survival',
    radius: Math.max(1, Math.min(128, Number(cfg.followRadius) || 5))
  };
}

/** Normalized guard settings shape sent to the client. */
function guardSettings(cfg) {
  return {
    enabled: !!cfg.guardEnabled,
    player: String(cfg.guardPlayer || ''),
    mode: cfg.guardMode === 'op' ? 'op' : 'survival',
    radius: Math.max(1, Math.min(128, Number(cfg.guardRadius) || 5)),
    attackRange: Math.max(2, Math.min(16, Number(cfg.guardAttackRange) || 8)),
    hostile: cfg.guardHostile !== false,
    passive: cfg.guardPassive !== false,
    players: !!cfg.guardPlayers
  };
}

/** Look-at-players settings shape. */
function lookSettings(cfg) {
  return { enabled: !!cfg.lookAtPlayers };
}

/** Normalized mining settings shape sent to the client. */
function miningSettings(cfg) {
  return {
    enabled: !!cfg.miningEnabled,
    mode: cfg.miningMode === 'stair' ? 'stair' : 'straight'
  };
}

/** Validate + normalize mining settings coming from the Controls page. */
function validateMiningSettings(data = {}) {
  // Unknown modes deliberately fall back to 'straight' (same as follow/guard).
  const enabled = !!data.enabled;
  const mode = data.mode === 'stair' ? 'stair' : 'straight';
  return { ok: true, value: { enabled, mode } };
}

/** Validate + normalize follow settings coming from the Controls page. */
function validateFollowSettings(data = {}) {
  const errors = [];
  const enabled = !!data.enabled;
  const player = String(data.player || '').trim();
  const mode = data.mode === 'op' ? 'op' : 'survival';
  const rawRadius = data.radius === undefined || data.radius === null || data.radius === '' ? 5 : Number(data.radius);
  const radius = Number.isFinite(rawRadius) ? rawRadius : 5;

  if (enabled && !player) errors.push('Pick a player name to follow when the toggle is on.');
  if (player.length > 32) errors.push('Player name must be 32 characters or fewer.');
  if (player && !/^[A-Za-z0-9_]{1,32}$/.test(player)) {
    errors.push('Player name may only contain letters, numbers and underscores.');
  }
  if (!Number.isInteger(radius) || radius < 1 || radius > 128) {
    errors.push('Follow radius must be a whole number between 1 and 128 blocks.');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { enabled, player, mode, radius } };
}

/** Validate + normalize guard settings coming from the Controls page. */
function validateGuardSettings(data = {}) {
  const errors = [];
  const enabled = !!data.enabled;
  const player = String(data.player || '').trim();
  const mode = data.mode === 'op' ? 'op' : 'survival';
  const rawRadius = data.radius === undefined || data.radius === null || data.radius === '' ? 5 : Number(data.radius);
  const radius = Number.isFinite(rawRadius) ? rawRadius : 5;
  const rawRange = data.attackRange === undefined || data.attackRange === null || data.attackRange === '' ? 8 : Number(data.attackRange);
  const attackRange = Number.isFinite(rawRange) ? rawRange : 8;

  if (enabled && !player) errors.push('Pick a player name to guard when the toggle is on.');
  if (player.length > 32) errors.push('Player name must be 32 characters or fewer.');
  if (player && !/^[A-Za-z0-9_]{1,32}$/.test(player)) {
    errors.push('Player name may only contain letters, numbers and underscores.');
  }
  if (!Number.isInteger(radius) || radius < 1 || radius > 128) {
    errors.push('Follow radius must be a whole number between 1 and 128 blocks.');
  }
  if (!Number.isInteger(attackRange) || attackRange < 2 || attackRange > 16) {
    errors.push('Attack range must be a whole number between 2 and 16 blocks.');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled,
      player,
      mode,
      radius,
      attackRange,
      hostile: data.hostile !== false,
      passive: data.passive !== false,
      players: !!data.players
    }
  };
}

function registerControlsSocketHandlers(io, botManager) {
  // Live follow + guard + mining status -> every dashboard client (Controls
  // page + anyone else).
  botManager.on('follow', (status) => io.emit('controls:status', status));
  botManager.on('guard', (status) => io.emit('controls:guard-status', status));
  botManager.on('mining', (status) => io.emit('controls:mining-status', status));

  io.on('connection', (socket) => {
    const cfg = loadConfig();
    socket.emit('controls:config', {
      ok: true,
      settings: followSettings(cfg),
      guard: guardSettings(cfg),
      look: lookSettings(cfg),
      mining: miningSettings(cfg)
    });

    socket.on('controls:get', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const c = loadConfig();
      if (ack)
        ack({
          ok: true,
          settings: followSettings(c),
          guard: guardSettings(c),
          look: lookSettings(c),
          mining: miningSettings(c)
        });
    });

    socket.on('controls:save', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') {
        if (ack) ack({ ok: false, errors: ['Admin permission required.'] });
        return;
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = validateFollowSettings(d);
      if (!result.ok) {
        if (ack) ack({ ok: false, errors: result.errors });
        return;
      }
      // Follow, Guard and Mining are mutually exclusive — turning one ON
      // persists the others as OFF so a bot restart can never arm two loops
      // (turning it OFF leaves the others untouched, e.g. the stop-now button).
      const saved = saveConfig({
        followEnabled: result.value.enabled,
        followPlayer: result.value.player,
        followMode: result.value.mode,
        followRadius: result.value.radius,
        ...(result.value.enabled ? { guardEnabled: false, miningEnabled: false } : {})
      });
      botManager.setFollow({
        enabled: saved.followEnabled,
        player: saved.followPlayer,
        mode: saved.followMode,
        radius: saved.followRadius
      });
      io.emit('controls:updated', { settings: followSettings(saved), guard: guardSettings(saved) });
      if (ack) ack({ ok: true, settings: followSettings(saved), guard: guardSettings(saved) });
    });

    // ---- Sleep / wake (any signed-in user, like bot:chat / bot:stop) ----

    socket.on('controls:sleep', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!socket.data || !socket.data.user) {
        if (ack) ack({ ok: false, errors: ['Authentication required.'] });
        return;
      }
      botManager
        .sleep()
        .then((res) => ack && ack(res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => ack && ack({ ok: false, errors: [err && err.message ? err.message : 'Sleep failed.'] }));
    });

    socket.on('controls:wake', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!socket.data || !socket.data.user) {
        if (ack) ack({ ok: false, errors: ['Authentication required.'] });
        return;
      }
      botManager
        .wake()
        .then((res) => ack && ack(res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => ack && ack({ ok: false, errors: [err && err.message ? err.message : 'Wake failed.'] }));
    });

    // ---- Look at players ----

    socket.on('controls:look-save', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') {
        if (ack) ack({ ok: false, errors: ['Admin permission required.'] });
        return;
      }
      const d = data && typeof data === 'object' ? data : {};
      const enabled = !!d.enabled;
      const saved = saveConfig({ lookAtPlayers: enabled });
      botManager.setLook({ enabled: saved.lookAtPlayers });
      io.emit('controls:look-updated', { look: lookSettings(saved) });
      if (ack) ack({ ok: true, look: lookSettings(saved) });
    });

    // ---- Guard ----

    socket.on('controls:guard-get', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const c = loadConfig();
      if (ack) ack({ ok: true, guard: guardSettings(c) });
    });

    socket.on('controls:guard-save', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') {
        if (ack) ack({ ok: false, errors: ['Admin permission required.'] });
        return;
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = validateGuardSettings(d);
      if (!result.ok) {
        if (ack) ack({ ok: false, errors: result.errors });
        return;
      }
      // Guard supersedes Follow — turning guard ON persists follow as OFF so
      // a bot restart can never arm both loops (turning it OFF leaves follow
      // untouched). Mining is excluded too.
      const saved = saveConfig({
        guardEnabled: result.value.enabled,
        guardPlayer: result.value.player,
        guardMode: result.value.mode,
        guardRadius: result.value.radius,
        guardAttackRange: result.value.attackRange,
        guardHostile: result.value.hostile,
        guardPassive: result.value.passive,
        guardPlayers: result.value.players,
        ...(result.value.enabled ? { followEnabled: false, miningEnabled: false } : {})
      });
      botManager.setGuard({
        enabled: saved.guardEnabled,
        player: saved.guardPlayer,
        mode: saved.guardMode,
        radius: saved.guardRadius,
        attackRange: saved.guardAttackRange,
        hostile: saved.guardHostile,
        passive: saved.guardPassive,
        players: saved.guardPlayers
      });
      io.emit('controls:guard-updated', { guard: guardSettings(saved), settings: followSettings(saved) });
      if (ack) ack({ ok: true, guard: guardSettings(saved), settings: followSettings(saved) });
    });

    // ---- Mining ----

    socket.on('controls:mining-save', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') {
        if (ack) ack({ ok: false, errors: ['Admin permission required.'] });
        return;
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = validateMiningSettings(d);
      if (!result.ok) {
        if (ack) ack({ ok: false, errors: result.errors });
        return;
      }
      // Mining is mutually exclusive with Follow and Guard — enabling it
      // persists both as OFF so a restart can never arm two movement loops.
      const saved = saveConfig({
        miningEnabled: result.value.enabled,
        miningMode: result.value.mode,
        ...(result.value.enabled ? { followEnabled: false, guardEnabled: false } : {})
      });
      botManager.setMining({ enabled: saved.miningEnabled, mode: saved.miningMode });
      io.emit('controls:mining-updated', { mining: miningSettings(saved) });
      if (ack) ack({ ok: true, mining: miningSettings(saved) });
    });

    // One-shot "mine the block I picked" — a bot action (like sleep/chat) so
    // any signed-in user may trigger it; the bot itself gates on being in a
    // server. Uses the nearest matching block within 5 blocks.
    socket.on('controls:mine-block', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (!socket.data || !socket.data.user) {
        if (ack) ack({ ok: false, errors: ['Authentication required.'] });
        return;
      }
      const d = data && typeof data === 'object' ? data : {};
      const block = String(d.block || '').trim().toLowerCase().slice(0, 64);
      if (!block) {
        if (ack) ack({ ok: false, errors: ['Pick a block to mine.'] });
        return;
      }
      botManager
        .mineBlock(block)
        .then((res) => ack && ack(res.ok ? res : { ok: false, errors: [res.error] }))
        .catch((err) => ack && ack({ ok: false, errors: [err && err.message ? err.message : 'Mining failed.'] }));
    });
  });
}

module.exports = {
  registerControlsSocketHandlers,
  validateFollowSettings,
  validateGuardSettings,
  validateMiningSettings,
  followSettings,
  guardSettings,
  lookSettings,
  miningSettings
};
