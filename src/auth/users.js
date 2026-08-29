'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR lets tests run against a throwaway directory so the user's real
// users.json is never touched. Falls back to the project root when unset.
const USERS_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'users.json')
  : path.join(__dirname, '..', '..', 'users.json');

const ROLES = { ADMIN: 'admin', GUEST: 'guest' };

// Default accounts come from environment variables (see .env / Render env
// vars), falling back to the documented out-of-the-box values. They are only
// used when the account doesn't exist yet in users.json.
const DEFAULT_USERS = [
  {
    id: 'admin',
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || 'admin',
    role: ROLES.ADMIN
  },
  {
    id: 'guest',
    username: process.env.GUEST_USERNAME || 'guest',
    password: process.env.GUEST_PASSWORD || 'guest',
    role: ROLES.GUEST
  }
];

// users: [{ id, username, passwordHash, role }] — passwordHash = "salt:hash"
let users = [];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hashHex] = String(stored).split(':');
  const hash = crypto.scryptSync(String(password), salt, 64);
  return crypto.timingSafeEqual(Buffer.from(hashHex, 'hex'), hash);
}

function save() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

/** Load users.json (or create it from env defaults). Called once at boot. */
function init() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (err) {
      console.error(`[auth] Could not read users.json (${err.message}); re-creating from defaults.`);
      users = [];
    }
  } else {
    users = [];
  }

  // Ensure both default accounts exist.
  for (const def of DEFAULT_USERS) {
    if (!users.some((u) => u.id === def.id)) {
      users.push({
        id: def.id,
        username: def.username,
        passwordHash: hashPassword(def.password),
        role: def.role
      });
      console.log(`[auth] Created default "${def.role}" account: ${def.username}`);
    }
  }

  // Keep every stored user well-formed. Note: passkeys are NOT injected
  // here — every accessor treats a missing field as an empty list, so an
  // untouched users.json stays byte-identical across boots (only saving a
  // real passkey persists the field).
  for (const u of users) {
    if (!u.role) u.role = u.id === 'admin' ? ROLES.ADMIN : ROLES.GUEST;
    if (!u.passwordHash) u.passwordHash = hashPassword('admin');
  }

  if (!process.env.ADMIN_PASSWORD) {
    console.log('[auth] ⚠  ADMIN_PASSWORD is not set — the default "admin" password is active.');
    console.log('[auth]    Set ADMIN_USERNAME / ADMIN_PASSWORD in .env (or Render env vars) before exposing this dashboard online.');
  }

  save();
  return users;
}

/** Public view of all accounts (no password hashes). */
function getUsers() {
  return users.map((u) => ({ id: u.id, username: u.username, role: u.role }));
}

function getUserById(id) {
  return users.find((u) => u.id === id) || null;
}

function getUserByUsername(username) {
  const name = String(username || '').trim().toLowerCase();
  return users.find((u) => u.username.trim().toLowerCase() === name) || null;
}

function authenticate(username, password) {
  const user = getUserByUsername(username);
  if (!user) return null;
  try {
    return verifyPassword(password, user.passwordHash) ? user : null;
  } catch (_) {
    return null;
  }
}

function changeUsername(id, newUsername) {
  const name = String(newUsername || '').trim();
  if (name.length < 3) return { ok: false, error: 'Username must be at least 3 characters.' };
  if (name.length > 24) return { ok: false, error: 'Username must be 24 characters or fewer.' };
  const user = getUserById(id);
  if (!user) return { ok: false, error: 'User not found.' };
  if (users.some((u) => u.id !== id && u.username.trim().toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: 'That username is already taken.' };
  }
  user.username = name;
  save();
  return { ok: true };
}

function changePassword(id, newPassword) {
  const pw = String(newPassword || '');
  if (pw.length < 4) return { ok: false, error: 'Password must be at least 4 characters.' };
  const user = getUserById(id);
  if (!user) return { ok: false, error: 'User not found.' };
  user.passwordHash = hashPassword(pw);
  save();
  return { ok: true };
}

/* ============================================================
   Passkeys (WebAuthn) — stored on each user record.
   A passkey credential is { id, publicKey (base64url), counter,
   transports, name, createdAt }. The private key never leaves the
   user's device — storing the public key + counter here is standard
   WebAuthn practice and is not a secret.
   ============================================================ */

/** Safe view of a passkey (no raw public key bytes) for the client UI. */
function safePasskey(p) {
  return {
    id: p.id,
    name: p.name || 'Passkey',
    transports: p.transports || [],
    createdAt: p.createdAt || null
  };
}

function getPasskeys(userId) {
  const u = getUserById(userId);
  return u && Array.isArray(u.passkeys) ? u.passkeys.map(safePasskey) : [];
}

function addPasskey(userId, cred) {
  const u = getUserById(userId);
  if (!u) return { ok: false, error: 'User not found.' };
  if (!Array.isArray(u.passkeys)) u.passkeys = [];
  if (u.passkeys.some((p) => p.id === cred.id)) {
    return { ok: false, error: 'That passkey is already registered.' };
  }
  const name = String(cred.name || '').trim();
  u.passkeys.push({
    id: cred.id,
    publicKey: cred.publicKey,
    counter: Number(cred.counter) || 0,
    transports: Array.isArray(cred.transports) ? cred.transports : [],
    name: name || `Passkey ${u.passkeys.length + 1}`,
    createdAt: new Date().toISOString()
  });
  save();
  return { ok: true, passkeys: u.passkeys.map(safePasskey) };
}

function removePasskey(userId, id) {
  const u = getUserById(userId);
  if (!u) return { ok: false, error: 'User not found.' };
  const before = (u.passkeys || []).length;
  u.passkeys = (u.passkeys || []).filter((p) => p.id !== id);
  if (u.passkeys.length === before) return { ok: false, error: 'Passkey not found.' };
  save();
  return { ok: true, passkeys: u.passkeys.map(safePasskey) };
}

/** Full passkey record (with public key) by credential id, or null. */
function getPasskeyRecord(userId, id) {
  const u = getUserById(userId);
  if (!u || !Array.isArray(u.passkeys)) return null;
  return u.passkeys.find((p) => p.id === id) || null;
}

/** The user account that owns a given credential id, or null. */
function getUserByPasskeyId(id) {
  return users.find((u) => Array.isArray(u.passkeys) && u.passkeys.some((p) => p.id === id)) || null;
}

function savePasskeyCounter(userId, id, counter) {
  const u = getUserById(userId);
  const p = u && u.passkeys && u.passkeys.find((x) => x.id === id);
  if (!p) return;
  p.counter = Number(counter) || p.counter;
  save();
}

module.exports = {
  init,
  getUsers,
  getUserById,
  getUserByUsername,
  authenticate,
  changeUsername,
  changePassword,
  getPasskeys,
  addPasskey,
  removePasskey,
  getPasskeyRecord,
  getUserByPasskeyId,
  savePasskeyCounter,
  ROLES
};
