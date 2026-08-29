'use strict';

const EventEmitter = require('events');
const path = require('path');
const { Server } = require('socket.io');

// Import prismarine-viewer's WorldView from the subpath directly. The
// package's main entry (index.js) pulls in server-side rendering modules that
// require the native `canvas` package (only a devDependency upstream), which
// breaks on machines without a native build. WorldView itself is pure JS, so
// requiring it directly keeps this dashboard free of native dependencies.
const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');

// Standalone viewer page + bundled client, served as static files.
const VIEWER_PUBLIC_DIR = path.join(
  path.dirname(require.resolve('prismarine-viewer/package.json')),
  'public'
);

const VIEWER_PATH = '/viewer';
const VIEW_DISTANCE = Number(process.env.VIEWER_DISTANCE) || 6;

/**
 * BotViewer
 * ---------
 * Serves a live 3D view of the bot's surroundings in the browser.
 *
 * Single-port design (required for free hosting like Render, which only
 * exposes ONE port):
 *  - the standalone viewer page is served by the MAIN Express app at /viewer/
 *  - the viewer's realtime channel is a SECOND Socket.io instance sharing the
 *    main HTTP server, mounted at /viewer/socket.io (the bundled viewer client
 *    connects to window.location.pathname + 'socket.io', so at /viewer/ it
 *    reaches /viewer/socket.io automatically)
 *
 * The Socket.io instance is created ONCE at startup and lives for the whole
 * process; attach()/detach() only swap which bot is streamed. Viewer sockets
 * are disconnected on detach so browsers reconnect and receive a fresh world
 * on the next bot.
 *
 * NOTE: this mirrors prismarine-viewer's official `mineflayer` helper, and
 * prismarine-viewer is pinned to an exact version in package.json — keep this
 * mirror in sync when upgrading.
 *
 * Emits:
 *   'state' (snapshot) — { running, url, error }
 */
class BotViewer extends EventEmitter {
  constructor({ server, socketAuth } = {}) {
    super();
    if (!server) {
      throw new Error('BotViewer requires a shared { server } (the main HTTP server)');
    }
    this.server = server;
    this.socketAuth = socketAuth || null;
    this.viewDistance = VIEW_DISTANCE;
    this.running = false;
    this.bot = null; // bot currently being streamed (set by attach)
    this.error = null;
    this.primitives = {};

    // Realtime channel for the viewer, sharing the main HTTP server.
    this.viewerIo = new Server(this.server, { path: VIEWER_PATH + '/socket.io' });
    if (this.socketAuth) this.viewerIo.use(this.socketAuth);
    this.viewerSockets = new Map(); // socket -> { worldView, bot, botPosition } | null

    this.viewerIo.on('connection', (socket) => {
      this.viewerSockets.set(socket, null);
      socket.on('disconnect', () => {
        const entry = this.viewerSockets.get(socket);
        if (entry) this.teardown(entry);
        this.viewerSockets.delete(socket);
      });
      this.initSocket(socket);
    });
  }

  /** Point the viewer at a spawned bot. Called by BotManager on 'spawn'. */
  attach(bot) {
    this.detach();
    this.bot = bot;
    this.running = true;
    this.error = null;

    // Drawing helpers the official viewer exposes on bot.viewer
    // (used by mineflayer-pathfinder to render paths, for example).
    bot.viewer = new EventEmitter();
    bot.viewer.erase = (id) => {
      delete this.primitives[id];
      for (const socket of this.viewerSockets.keys()) socket.emit('primitive', { id });
    };
    bot.viewer.drawBoxGrid = (id, start, end, color = 'aqua') => {
      this.primitives[id] = { type: 'boxgrid', id, start, end, color };
      for (const socket of this.viewerSockets.keys()) socket.emit('primitive', this.primitives[id]);
    };
    bot.viewer.drawLine = (id, points, color = 0xff0000) => {
      this.primitives[id] = { type: 'line', id, points, color };
      for (const socket of this.viewerSockets.keys()) socket.emit('primitive', this.primitives[id]);
    };
    bot.viewer.drawPoints = (id, points, color = 0xff0000, size = 5) => {
      this.primitives[id] = { type: 'points', id, points, color, size };
      for (const socket of this.viewerSockets.keys()) socket.emit('primitive', this.primitives[id]);
    };
    bot.viewer.close = () => this.detach();

    // (Re)initialize every connected viewer client with this bot.
    for (const socket of this.viewerSockets.keys()) this.initSocket(socket);

    this.emit('state', this.snapshot());
    console.log(`[viewer] 3D viewer → ${VIEWER_PATH}/ (same port as dashboard)`);
  }

  /** Stop streaming (called on bot end/stop). Client sockets get disconnected. */
  detach() {
    if (!this.bot && !this.running) return;
    for (const entry of this.viewerSockets.values()) this.teardown(entry);
    for (const socket of this.viewerSockets.keys()) socket.disconnect(true);
    this.bot = null;
    this.running = false;
    this.primitives = {}; // drawings belong to the previous bot session
    this.emit('state', this.snapshot());
  }

  /** Stream the current bot to one viewer client (no-op if none attached). */
  initSocket(socket) {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    const entry = this.viewerSockets.get(socket);
    if (entry && entry.bot === bot) return; // already streaming this bot
    if (entry) this.teardown(entry); // switch from a previous bot

    socket.emit('version', bot.version);
    // Re-send drawings (paths, boxes…) made since the last reset, mirroring
    // the official helper.
    for (const id in this.primitives) socket.emit('primitive', this.primitives[id]);

    const worldView = new WorldView(bot.world, this.viewDistance, bot.entity.position, socket);
    worldView.init(bot.entity.position).catch((err) => {
      console.error('[viewer] chunk load error:', err && err.message);
    });
    worldView.on('blockClicked', (block, face, button) => {
      if (bot.viewer) bot.viewer.emit('blockClicked', block, face, button);
    });

    const botPosition = () => {
      socket.emit('position', { pos: bot.entity.position, yaw: bot.entity.yaw, addMesh: true });
      worldView.updatePosition(bot.entity.position);
    };

    bot.on('move', botPosition);
    worldView.listenToBot(bot);

    this.viewerSockets.set(socket, { worldView, bot, botPosition });
  }

  /** Remove a worldView's listeners from its bot. */
  teardown(entry) {
    if (!entry) return;
    try {
      entry.worldView.removeListenersFromBot(entry.bot);
    } catch (_) {
      /* ignore */
    }
    try {
      entry.bot.removeListener('move', entry.botPosition);
    } catch (_) {
      /* ignore */
    }
  }

  /** State snapshot sent to the dashboard. */
  snapshot() {
    return {
      running: this.running,
      url: VIEWER_PATH + '/',
      error: this.error
    };
  }
}

module.exports = { BotViewer, VIEWER_PUBLIC_DIR, VIEWER_PATH };
