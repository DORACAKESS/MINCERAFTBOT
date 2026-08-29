'use strict';

/* ============================================================
   MineBot — Command Commander socket handlers
   Client -> server:  commander:get, commander:save, commander:commands
   Server -> client:  commander:updated (broadcast after a save)
   ============================================================ */

const { CATEGORIES, LEVEL_NAMES } = require('../commander/commands');

function registerCommanderSocketHandlers(io, commanderStore) {
  io.on('connection', (socket) => {
    socket.emit('commander:config', {
      ok: true,
      config: commanderStore.get(),
      levelNames: LEVEL_NAMES
    });

    socket.on('commander:get', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (ack) ack({ ok: true, config: commanderStore.get(), levelNames: LEVEL_NAMES });
    });

    socket.on('commander:commands', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      if (ack) ack({ ok: true, categories: CATEGORIES, levelNames: LEVEL_NAMES });
    });

    socket.on('commander:save', (data, ack) => {
      if (typeof ack !== 'function') ack = typeof data === 'function' ? data : undefined;
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') {
        if (ack) ack({ ok: false, errors: ['Admin permission required.'] });
        return;
      }
      const d = data && typeof data === 'object' ? data : {};
      // The command prefix is fixed to "." (matching the command reference /
      // .help output) — it is not configurable to avoid display mismatches.
      const result = commanderStore.save({
        enabled: !!d.enabled,
        prefix: '.',
        players: Array.isArray(d.players) ? d.players : []
      });
      if (!result.ok) {
        if (ack) ack({ ok: false, errors: result.errors });
        return;
      }
      io.emit('commander:updated', { config: result.settings, levelNames: LEVEL_NAMES });
      if (ack) ack({ ok: true, config: result.settings });
    });
  });
}

module.exports = { registerCommanderSocketHandlers };
