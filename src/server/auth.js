'use strict';

const usersStore = require('../auth/users');
const session = require('../auth/session');
const passkeys = require('../auth/passkeys');

// Paths anyone can reach without logging in. Everything else requires auth.
const PUBLIC_EXACT = [
  '/login.html',
  '/health',
  '/api/health',
  '/diagnostics/health',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/passkey/login/start',
  '/api/auth/passkey/login/verify'
];
const PUBLIC_PREFIX = ['/css/', '/js/', '/socket.io/'];

function isPublicPath(pathname) {
  if (PUBLIC_EXACT.includes(pathname)) return true;
  return PUBLIC_PREFIX.some((p) => pathname.startsWith(p));
}

// ---- Simple login rate limiting (brute-force guard) ----
// Keyed by client IP + username so one attacker can't lock out everyone.
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map(); // "ip:username" -> { count, resetAt }

function loginBlocked(ip, username) {
  const key = `${ip}:${String(username).toLowerCase()}`;
  const e = loginFails.get(key);
  if (!e) return false;
  if (e.resetAt <= Date.now()) {
    loginFails.delete(key);
    return false;
  }
  return e.count >= LOGIN_MAX_FAILS;
}

function recordLoginFail(ip, username) {
  const key = `${ip}:${String(username).toLowerCase()}`;
  const now = Date.now();
  const e = loginFails.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (e.resetAt <= now) {
    e.count = 0;
    e.resetAt = now + LOGIN_WINDOW_MS;
  }
  e.count += 1;
  loginFails.set(key, e);
}

function clearLoginFails(ip, username) {
  loginFails.delete(`${ip}:${String(username).toLowerCase()}`);
}

const loginCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, e] of loginFails) {
    if (e.resetAt <= now) loginFails.delete(key);
  }
}, 60 * 60 * 1000);
loginCleanup.unref();

/** Current authenticated user for an Express request (or null). */
function getCurrentUser(req) {
  const token = session.getTokenFromCookie(req.headers.cookie);
  const userId = token ? session.getSessionUser(token) : null;
  const user = userId ? usersStore.getUserById(userId) : null;
  return user ? { id: user.id, username: user.username, role: user.role } : null;
}

/**
 * Express middleware — protects every route except the public whitelist.
 * Place BEFORE express.static so page files are guarded too.
 */
function requireAuth(req, res, next) {
  if (isPublicPath(req.path)) return next();
  const user = getCurrentUser(req);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    return res.redirect('/login.html');
  }
  req.user = user;
  next();
}

/**
 * Socket.io middleware — verifies the session cookie before allowing a
 * connection. Used by BOTH the dashboard socket.io and the 3D viewer's
 * socket.io (the viewer page runs inside a same-origin iframe and sends the
 * same cookie).
 */
function socketAuth(socket, next) {
  const token = session.getTokenFromCookie(socket.request.headers.cookie);
  const userId = token ? session.getSessionUser(token) : null;
  const user = userId ? usersStore.getUserById(userId) : null;
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = { id: user.id, username: user.username, role: user.role };
  next();
}

function isAdmin(req) {
  return req.user && req.user.role === usersStore.ROLES.ADMIN;
}

function registerAuthRoutes(app) {
  const cookieOptions = (req) => ({
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || (req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https',
    maxAge: session.TTL_MS,
    path: '/'
  });

  app.post('/api/auth/login', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    if (loginBlocked(ip, username)) {
      return res.status(429).json({
        ok: false,
        error: 'Too many failed attempts. Try again in a few minutes.'
      });
    }

    const user = usersStore.authenticate(username, password);
    if (!user) {
      recordLoginFail(ip, username);
      return res.status(401).json({ ok: false, error: 'Invalid username or password.' });
    }
    clearLoginFails(ip, username);

    const token = session.createSession(user.id);
    res.cookie(session.COOKIE_NAME, token, cookieOptions(req));
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
  });

  app.post('/api/auth/logout', (req, res) => {
    session.destroySession(session.getTokenFromCookie(req.headers.cookie));
    res.clearCookie(session.COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    res.json({ ok: true, user: req.user });
  });

  // ---- Passkeys (WebAuthn) ----
  // Registering a passkey requires a signed-in session (do it from the
  // Settings page). Signing in WITH a passkey is public.
  // Express 4 does not catch async rejections, so wrap the async routes
  // to turn any unexpected throw into a clean 500 JSON response.
  const asyncRoute = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error('[auth] passkey route error:', err && err.message ? err.message : err);
      if (!res.headersSent) res.status(500).json({ ok: false, error: 'Passkey error — please try again.' });
    });

  app.post('/api/auth/passkey/register/start', asyncRoute(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const existing = usersStore.getPasskeys(req.user.id);
    const rpID = passkeys.rpIDFor(req);
    const result = await passkeys.startRegistration(
      { id: req.user.id, username: req.user.username },
      rpID,
      existing
    );
    res.json({ ok: true, challengeId: result.challengeId, options: result.options });
  }));

  app.post('/api/auth/passkey/register/verify', asyncRoute(async (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rpID = passkeys.rpIDFor(req);
    const origin = passkeys.originFor(req);
    const name = String(body.name || '').trim().slice(0, 40);
    const result = await passkeys.verifyRegistration(
      req.user.id,
      String(body.challengeId || ''),
      body.credential,
      origin,
      rpID
    );
    if (!result.ok) return res.status(400).json(result);
    const stored = usersStore.addPasskey(req.user.id, { ...result.credential, name });
    if (!stored.ok) return res.status(400).json(stored);
    res.json({ ok: true, passkeys: stored.passkeys });
  }));

  app.get('/api/auth/passkeys', (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    res.json({ ok: true, passkeys: usersStore.getPasskeys(req.user.id) });
  });

  app.delete('/api/auth/passkeys/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    const result = usersStore.removePasskey(req.user.id, String(req.params.id));
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, passkeys: result.passkeys });
  });

  app.post('/api/auth/passkey/login/start', asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const username = String(body.username || '').trim();
    let passkeyList = [];
    if (username) {
      const u = usersStore.getUserByUsername(username);
      if (u) passkeyList = usersStore.getPasskeys(u.id);
    }
    const rpID = passkeys.rpIDFor(req);
    const result = await passkeys.startLogin(rpID, passkeyList);
    // `allowed` is only meaningful when the user typed a username (so we can
    // say "this account has no passkeys"). Without one, the browser offers
    // every passkey saved for this site, so report null instead of false.
    res.json({
      ok: true,
      challengeId: result.challengeId,
      options: result.options,
      allowed: username ? !!result.allowed : null
    });
  }));

  app.post('/api/auth/passkey/login/verify', asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const rpID = passkeys.rpIDFor(req);
    const origin = passkeys.originFor(req);
    const result = await passkeys.verifyLogin(
      String(body.challengeId || ''),
      body.credential,
      origin,
      rpID,
      usersStore
    );
    if (!result.ok) return res.status(400).json(result);
    const token = session.createSession(result.user.id);
    res.cookie(session.COOKIE_NAME, token, cookieOptions(req));
    res.json({ ok: true, user: result.user });
  }));

  // ---- Admin-only account management ----

  app.get('/api/auth/users', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Admin permission required.' });
    res.json({ ok: true, users: usersStore.getUsers() });
  });

  app.post('/api/auth/change-username', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Admin permission required.' });
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const result = usersStore.changeUsername(String(body.userId || ''), String(body.newUsername || ''));
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true });
  });

  app.post('/api/auth/change-password', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const targetId = String(body.userId || '');
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    const me = req.user;
    if (!me) return res.status(401).json({ ok: false, error: 'Unauthorized' });

    const isSelf = !targetId || targetId === me.id;
    const target = usersStore.getUserById(isSelf ? me.id : targetId);
    if (!target) return res.status(400).json({ ok: false, error: 'User not found.' });

    // Changing another account's password requires admin.
    if (!isSelf && me.role !== usersStore.ROLES.ADMIN) {
      return res.status(403).json({ ok: false, error: 'Admin permission required.' });
    }
    // Changing your own password requires the current one.
    if (isSelf && !usersStore.authenticate(me.username, currentPassword)) {
      return res.status(400).json({ ok: false, error: 'Current password is incorrect.' });
    }

    const result = usersStore.changePassword(target.id, newPassword);
    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true });
  });
}

module.exports = { requireAuth, socketAuth, getCurrentUser, isAdmin, registerAuthRoutes };
