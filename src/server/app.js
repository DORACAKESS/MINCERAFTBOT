'use strict';

const path = require('path');
const express = require('express');

const { getSupportedVersions } = require('../constants/versions');
const { loadConfig } = require('../config/store');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const PKG = require('../../package.json');

/**
 * Builds the Express app:
 *  - serves the static dashboard (index.html, css, js) and, when
 *    `viewerStaticDir` is provided, the 3D viewer page at /viewer/
 *  - exposes UptimeRobot-friendly health + diagnostics endpoints
 *  - JSON 404 for unknown /api routes, themed HTML 404 for everything else
 */
function createApp({ getBotState, getViewerState, viewerStaticDir, authMiddleware, authSetup, aiSetup } = {}) {
  const app = express();
  app.disable('x-powered-by');

  // Trust the first hop (Render's / Heroku-style proxy). Without this, every
  // request behind Render's proxy looks like it comes from the same IP:
  // req.secure would always be false and the login rate-limiter would share
  // ONE key across all visitors (5 failed tries from anyone would lock out
  // everyone). With trust proxy enabled, req.ip/req.secure reflect the real
  // client and protocol. Harmless on a local Windows machine (no proxy).
  app.set('trust proxy', 1);

  app.use(express.json());

  // Keep dashboard JS/CSS/HTML fresh: the dev watcher restarts the server on
  // every code change, so a cached settings.js/dashboard.js could otherwise
  // mask a fix. `no-cache` still allows ETag revalidation (fast, never stale).
  app.use((req, res, next) => {
    if (/\.(js|css|html)$/i.test(req.path)) res.setHeader('Cache-Control', 'no-cache');
    next();
  });

  // Protect everything (pages AND API) except the public whitelist.
  if (authMiddleware) app.use(authMiddleware);

  app.use(express.static(PUBLIC_DIR));

  // Tabler icon SVGs (v3 outline set) served from the installed package, so
  // JS-generated UI (tooltips, quick-command chips, status pills) can drop in
  // <img src="/icons/name.svg"> without a CDN. Static HTML inlines the same
  // SVG markup directly instead, so those icons inherit text color.
  const TABLER_ICONS_DIR = path.join(__dirname, '..', '..', 'node_modules', '@tabler', 'icons', 'icons', 'outline');
  app.use('/icons', express.static(TABLER_ICONS_DIR));

  if (viewerStaticDir) {
    // Our custom viewer page + patched client bundle live in public/viewer/.
    // They are served by explicit routes so they win over the stock
    // prismarine-viewer assets, which are still mounted below for the
    // worker + textures + blocksStates (paths the bundle resolves relative
    // to the page URL, e.g. /viewer/worker.js, /viewer/textures/…).
    const viewerCustomDir = path.join(PUBLIC_DIR, 'viewer');
    app.get('/viewer/', (req, res) => {
      res.sendFile(path.join(viewerCustomDir, 'index.html'));
    });
    app.get('/viewer/index.js', (req, res) => {
      res.sendFile(path.join(viewerCustomDir, 'index.js'));
    });
    app.use('/viewer', express.static(viewerStaticDir));
  }

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  });

  // Simple always-200 check for uptime monitors (UptimeRobot, cron, etc.)
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/diagnostics/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Full diagnostics: runtime, memory, bot + viewer state.
  app.get('/diagnostics', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      service: PKG.name,
      version: PKG.version,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal
      },
      bot: typeof getBotState === 'function' ? getBotState() : null,
      viewer: typeof getViewerState === 'function' ? getViewerState() : null
    });
  });

  // Auth routes (login/logout/account management) registered before the
  // /api 404 catch-all so they actually get reached.
  if (authSetup) authSetup(app);

  // AI admin routes (key management + AI settings).
  if (aiSetup) aiSetup(app);

  app.get('/api/versions', (req, res) => {
    res.json(getSupportedVersions());
  });

  // REST fallbacks for the sticky top bar (config + bot state over plain
  // HTTP instead of sockets). Sessions work through proxies / on Render,
  // so the bar can never sit on "—" just because a websocket upgrade was
  // flaky. Socket events still deliver the live updates on top.
  // The server-login password is redacted for non-admin roles (guests can
  // read name/server/version but never the AuthMe password).
  const redactForGuest = (cfg, req) =>
    cfg && req.user && req.user.role !== 'admin' ? { ...cfg, loginPassword: '' } : cfg;

  app.get('/api/config', (req, res) => {
    res.json({ ok: true, config: redactForGuest(loadConfig(), req) });
  });

  app.get('/api/bot/state', (req, res) => {
    const st = typeof getBotState === 'function' ? getBotState() : null;
    if (st && st.config) st.config = redactForGuest(st.config, req);
    res.json({ ok: true, state: st });
  });

  // Unknown API routes → JSON 404
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Everything else → themed 404 page
  app.use((req, res) => {
    res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  });

  return app;
}

module.exports = { createApp };
