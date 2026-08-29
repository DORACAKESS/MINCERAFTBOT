'use strict';

/* ============================================================
   MineBot — AI socket handlers
   Client -> server:  ai:send (chat), ai:confirm-response, ai:cancel
   Server -> client:  ai:thinking, ai:confirm, ai:response
   (ai:game-message is broadcast by server.js for in-game chat)
   ============================================================ */

const { AGENT_MODES } = require('../ai/engine');

function registerAISocketHandlers(io, engine) {
  io.on('connection', (socket) => {
    socket.on('ai:send', (data, ack) => {
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') {
        if (typeof ack === 'function') ack({ ok: false, error: 'Admin permission required.' });
        return;
      }
      const payload = data && typeof data === 'object' ? data : {};
      const keyName = String(payload.keyName || '').trim();
      const message = String(payload.message || '').trim();
      if (!keyName || !message) {
        if (typeof ack === 'function') ack({ ok: false, error: 'Select an AI and type a message first.' });
        return;
      }
      if (typeof ack === 'function') ack({ ok: true });
      engine.chat({
        socket,
        keyName,
        message,
        history: Array.isArray(payload.history) ? payload.history : [],
        source: 'ui',
        // The AI page mode selector: 'agent' (all tools) or 'build'
        // (construction specialist). Anything else falls back to agent.
        mode: AGENT_MODES.includes(payload.mode) ? payload.mode : 'agent'
      });
    });

    socket.on('ai:confirm-response', (data) => {
      // Approving/denying a tool confirm is a privileged action — mirror the
      // ai:send gate so a guest can never approve (or veto) a tool.
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') return;
      const d = data && typeof data === 'object' ? data : {};
      engine.resolveConfirm(String(d.id || ''), !!d.approved);
    });

    // "Stop generating": abort every in-flight AI run for this engine. Admin
    // only — stopping a generation is a privileged action, same as sending.
    socket.on('ai:cancel', () => {
      const user = socket.data && socket.data.user;
      if (!user || user.role !== 'admin') return;
      if (typeof engine.cancelActive === 'function') engine.cancelActive();
    });
  });
}

module.exports = { registerAISocketHandlers };
