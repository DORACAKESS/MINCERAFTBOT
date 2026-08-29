'use strict';

require('dotenv').config();

const http = require('http');
const { Server } = require('socket.io');

const { createApp } = require('./src/server/app');
const { registerSocketHandlers } = require('./src/server/socket');
const { registerAuthRoutes, requireAuth, socketAuth, isAdmin } = require('./src/server/auth');
const usersStore = require('./src/auth/users');
const { BotManager } = require('./src/bot/botManager');
const { loadConfig } = require('./src/config/store');
const { VIEWER_PUBLIC_DIR } = require('./src/bot/viewer');

// ---- AI ----
const aiKeys = require('./src/ai/keys');
const aiSettings = require('./src/ai/settings');
const providers = require('./src/ai/providers');
const { createEngine } = require('./src/ai/engine');
const { registerAIRoutes } = require('./src/server/ai-routes');
const { registerAISocketHandlers } = require('./src/server/ai-socket');

// ---- Command Commander (authorized in-game commands) ----
const commanderStore = require('./src/commander/store');
const { createCommander } = require('./src/commander');
const { registerCommanderSocketHandlers } = require('./src/server/commander-socket');

// ---- Building (schematic / litematic library + in-game builder) ----
const buildingStore = require('./src/building/store');
const { createBuilder } = require('./src/building/builder');
const { registerBuildingSocketHandlers } = require('./src/server/building-socket');

// ---- Controls (follow-player etc.) ----
const { registerControlsSocketHandlers } = require('./src/server/controls-socket');

// Render (free tier) only exposes ONE port — everything runs on it:
// dashboard, socket.io (/socket.io) and the 3D viewer (/viewer/).
// The port is configurable via PORT in the .env file (or an env var);
// it falls back to 3000 when unset or invalid (e.g. 3000 is busy).
function resolvePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 3000;
}
const PORT = resolvePort(process.env.PORT);

// Create default accounts (admin/guest) from .env / Render env vars.
usersStore.init();
aiKeys.init();
aiSettings.init();
commanderStore.init();
buildingStore.init();

let gameHistory = []; // short memory for in-game AI conversations
let gameActivity = []; // recent in-game chat + AI replies, replayed to AI pages
const MAX_GAME_ACTIVITY = 50;
let lastGameAiAt = 0;
const GAME_AI_COOLDOWN_MS = 2000; // guard against chat-spam burning tokens

let botManager = null;

// The build executor is created before the engine so the Build Agent's
// getBuilding getter references a fully-initialised builder (no TDZ hazard).
// Its getBotManager is lazy too — botManager is assigned a few lines down.
const builder = createBuilder({ getBotManager: () => botManager, store: buildingStore });

const engine = createEngine({
  getKeys: () => aiKeys,
  getSettings: () => aiSettings.get(),
  getBotManager: () => botManager,
  getCommander: () => commanderStore.get(),
  getBuilding: () => ({ store: buildingStore, builder }),
  providers
});

const app = createApp({
  getBotState: () => (botManager ? botManager.snapshot() : null),
  getViewerState: () => (botManager ? botManager.viewer.snapshot() : null),
  viewerStaticDir: VIEWER_PUBLIC_DIR,
  authMiddleware: requireAuth,
  authSetup: (app) => registerAuthRoutes(app),
  aiSetup: (app) => registerAIRoutes(app, { keysStore: aiKeys, settingsStore: aiSettings, isAdmin })
});

const server = http.createServer(app);
const io = new Server(server);

botManager = new BotManager({ server, socketAuth });
registerSocketHandlers(io, botManager, socketAuth);
registerAISocketHandlers(io, engine);

const commander = createCommander({ store: commanderStore, getBotManager: () => botManager });
registerCommanderSocketHandlers(io, commanderStore);

// Building: progress events broadcast to every dashboard client.
registerBuildingSocketHandlers(io, buildingStore, builder);

// Controls: follow-player settings + live follow status.
registerControlsSocketHandlers(io, botManager);

// ---- In-game chat -> AI bridge ----
// When the AI chat bridge is enabled, prefixed (or all) in-game messages
// appear in the AI page UI and are answered by the selected AI.
botManager.on('game-chat', ({ username, message }) => {
  const s = aiSettings.get();
  if (!s.mcChatAI) return;
  if (typeof message !== 'string' || !message.trim()) return;
  let clean = message.trim();
  if (s.usePrefix) {
    const pre = s.prefixChar || '!';
    if (!clean.startsWith(pre)) return;
    clean = clean.slice(pre.length).trim();
  }
  if (!clean) return;
  // Keep a short activity log so a user who is NOT on the AI tab (or who
  // refreshes) still sees what happened while they were away.
  gameActivity.push({ role: 'game', username, message: clean });
  if (gameActivity.length > MAX_GAME_ACTIVITY) gameActivity.shift();
  io.emit('ai:game-message', { username, message: clean });
  // When commanders are configured, only authorized players may trigger the
  // AI (unlisted players can still chat — it shows in the dashboard, but the
  // AI won't act on it).
  if (commanderStore.isConfigured() && !commanderStore.getLevel(username)) return;
  const key = s.activeKey ? aiKeys.byName(s.activeKey) : null;
  if (!key) return;
  const now = Date.now();
  if (now - lastGameAiAt < GAME_AI_COOLDOWN_MS) return;
  lastGameAiAt = now;
  engine
    .chat({
      io,
      keyName: s.activeKey,
      message: `[in-game] ${username}: ${clean}`,
      history: gameHistory,
      source: 'game'
    })
    .then((res) => {
      const reply = res && res.text ? res.text : '';
      gameHistory.push({ role: 'user', content: `[in-game] ${username}: ${clean}` });
      if (reply) {
        gameHistory.push({ role: 'assistant', content: reply });
        // Surface the in-game AI reply on the AI page too, even for users
        // who reconnect later.
        gameActivity.push({ role: 'assistant', message: reply });
        if (gameActivity.length > MAX_GAME_ACTIVITY) gameActivity.shift();
      }
      if (gameHistory.length > 40) gameHistory = gameHistory.slice(-40);
    });
});

// ---- In-game Commander ----
// Authorized players (set in the Commander page) can run .commands in the
// Minecraft chat — .help, .stats:health, .inv:drop cobblestone, .bot:stop,
// etc. Works even when the AI chat bridge is off. Replies go to the chat.
// Minecraft chat lines are limited to 256 characters, so each reply is
// sent as its own chat message: an ARRAY reply (.help listings) becomes
// one message per command, and a single long reply is split at word
// boundaries into separate lines. Lines are spaced ~350 ms apart so the
// paged .help never trips a server's chat-rate / anti-spam limit.
const COMMANDER_LINE_DELAY_MS = 350;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendCommanderReply(reply) {
  if (botManager.state !== 'connected') return;
  const lines = commander.toLines(reply);
  for (let i = 0; i < lines.length; i++) {
    if (botManager.state !== 'connected') return; // bot went offline mid-reply
    let rest = String(lines[i]);
    while (rest.length > 250) {
      let cut = rest.lastIndexOf(' ', 250);
      if (cut < 60) cut = 250; // one long token — hard cut
      botManager.sendChat(rest.slice(0, cut));
      rest = rest.slice(cut).trim();
      await delay(COMMANDER_LINE_DELAY_MS);
    }
    if (rest) {
      botManager.sendChat(rest);
      await delay(COMMANDER_LINE_DELAY_MS);
    }
  }
}

botManager.on('game-chat', ({ username, message }) => {
  Promise.resolve(commander.handleChat(username, message)).then(sendCommanderReply);
});

// Replay recent in-game activity to a freshly connected client so nothing is
// lost when the user is away from the AI tab (or refreshes the page). The
// AI page dedupes these against its own localStorage history.
io.on('connection', (socket) => {
  if (gameActivity.length) {
    socket.emit('ai:activity-history', gameActivity.slice(-40));
  }
});

// Friendly error if the port is already taken (double-clicking start.bat twice).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  [ERROR] Port ${PORT} is already in use.`);
    console.error('  Pick a free port and try again:');
    console.error('');
    console.error('      In .env:      PORT=3001');
    console.error('      or one-off:   set PORT=3001   &&   npm start');
    console.error('');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  const cfg = loadConfig();
  const renderUrl = process.env.RENDER_EXTERNAL_URL || '';
  console.log('');
  console.log('  ⛏  Minecraft Bot Dashboard');
  console.log('  ─────────────────────────────────────────');
  console.log(`  • Dashboard : http://localhost:${PORT}`);
  console.log(`  • Login     : http://localhost:${PORT}/login.html`);
  console.log(`  • 3D Map    : http://localhost:${PORT}/map.html`);
  console.log(`  • Controls  : http://localhost:${PORT}/controls.html`);
  console.log(`  • Health    : http://localhost:${PORT}/health`);
  if (renderUrl) console.log(`  • Public    : ${renderUrl}  (Render — HTTPS is automatic)`);
  console.log(`  • Bot       : "${cfg.botName}" → ${cfg.serverIp}:${cfg.serverPort} (MC ${cfg.version})`);
  console.log(`  • State     : ${botManager.state}`);
  console.log('');
});

// ---- Safety nets ----
// The Mineflayer bot talks to arbitrary third-party servers. A malformed
// server, a bad protocol edge case or a dependency quirk must NEVER take
// the whole dashboard down (especially on Render, where the process dying
// means the site goes offline). Log these loudly and keep serving.
process.on('uncaughtException', (err) => {
  console.error('[guard] Uncaught exception (keeping the server alive):');
  console.error(err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[guard] Unhandled promise rejection (keeping the server alive):');
  console.error(reason && reason.stack ? reason.stack : reason);
});

// Graceful shutdown (Ctrl+C in the terminal / closing the window).
function shutdown() {
  console.log('\n  Shutting down…');
  botManager.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
