'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE_NAME = 'minebot_session';
const TTL_MS = (Number(process.env.SESSION_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000;

// Sessions are persisted to disk (sessions.json) so a login survives a
// server restart — the auto-restart watcher restarts the server constantly
// while you edit, and Render recycles instances; without this you'd be
// asked for the password again every time. DATA_DIR lets tests run against
// a throwaway directory so the real sessions.json is never touched.
const SESSIONS_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'sessions.json')
  : path.join(__dirname, '..', '..', 'sessions.json');

// In-memory session store: token -> { userId, expiresAt }.
// Keyed by a stable user id, so changing a username doesn't invalidate an
// active login. On Render, the disk is ephemeral: sessions survive normal
// restarts but reset on a redeploy (the disk is wiped) — you sign in again.
const sessions = new Map();

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    const stored = JSON.parse(raw);
    if (!stored || typeof stored !== 'object') return;
    const now = Date.now();
    for (const [token, s] of Object.entries(stored)) {
      if (s && s.userId && typeof s.expiresAt === 'number' && s.expiresAt > now) {
        sessions.set(token, { userId: s.userId, expiresAt: s.expiresAt });
      }
    }
  } catch (_) {
    /* missing/corrupt file — start with an empty store */
  }
}

function persistSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (err) {
    // Never take the dashboard down over a session file (e.g. read-only fs).
    console.error('[session] could not persist sessions:', err && err.message ? err.message : err);
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, expiresAt: Date.now() + TTL_MS });
  persistSessions();
  return token;
}

function getSessionUser(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) {
    sessions.delete(token);
    persistSessions();
    return null;
  }
  return s.userId;
}

function destroySession(token) {
  if (token && sessions.delete(token)) persistSessions();
}

/** Extract our cookie value from a raw Cookie header. */
function getTokenFromCookie(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

// Periodic cleanup of expired sessions (keeps the map and file from growing
// forever). Persists only when something was actually removed.
const cleanup = setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [token, s] of sessions) {
    if (s.expiresAt <= now) {
      sessions.delete(token);
      removed = true;
    }
  }
  if (removed) persistSessions();
}, 60 * 60 * 1000);
cleanup.unref();

// Boot-time load (before any request can create a session).
loadSessions();

module.exports = { createSession, getSessionUser, destroySession, getTokenFromCookie, COOKIE_NAME, TTL_MS };
