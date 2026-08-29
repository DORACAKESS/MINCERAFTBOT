'use strict';

/* ============================================================
   MineBot — Passkey (WebAuthn) helpers
   ------------------------------------------------------------
   Wraps @simplewebauthn/server so the dashboard can offer passwordless
   sign-in with platform passkeys (Windows Hello, Touch ID, fingerprint…).

   Why it works on Render + localhost:
    - WebAuthn requires a "secure context" — HTTPS on Render and
      localhost on your PC are both secure contexts, so passkeys work
      in both places.
    - The RP ID is derived from the request hostname (e.g. localhost or
      your-app.onrender.com), and the expected origin from the request —
      no hardcoded domains needed.

   Security:
    - Challenges are single-use and expire after 5 minutes.
    - The private key never leaves the user's device; we only store the
      public key + a replay-protection counter (standard WebAuthn).
    - Verification enforces the expected RP ID, origin and challenge.
   ============================================================ */

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'MineBot Dashboard';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// challengeId -> { challenge, userId, username, expiresAt }
const challenges = new Map();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challenges) {
    if (c.expiresAt <= now) challenges.delete(id);
  }
}, 60 * 1000);
cleanup.unref();

/** RP ID = the request's hostname without the port (localhost / your-app.onrender.com). */
function rpIDFor(req) {
  return String(req.get('host') || '').split(':')[0] || 'localhost';
}

/** Full origin as the browser sees it (works behind Render's HTTPS proxy). */
function originFor(req) {
  const proto = (req.get('x-forwarded-proto') || '').split(',')[0].trim() || req.protocol || 'http';
  return `${proto}://${req.get('host')}`;
}

function storeChallenge(challenge, userId, username) {
  const id = crypto.randomBytes(16).toString('hex');
  challenges.set(id, { challenge, userId, username, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return id;
}

function takeChallenge(challengeId) {
  if (!challengeId) return null;
  const c = challenges.get(challengeId);
  if (!c) return null;
  challenges.delete(challengeId); // single-use
  if (c.expiresAt <= Date.now()) return null;
  return c;
}

/** Build the options for navigator.credentials.create(...). */
async function startRegistration(user, rpID, existingPasskeys) {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: user.username,
    userID: new TextEncoder().encode('mb:' + user.id),
    attestationType: 'none',
    // REQUIRED resident key = a true passkey: the credential is stored on
    // the device and is discoverable, so "Sign in with passkey" on the login
    // page works WITHOUT typing a username (navigator.credentials.get with no
    // allowCredentials). With 'preferred', Windows/Chrome may create a
    // NON-resident credential that get() can never find -> NotAllowedError
    // ("No passkey matched") on the very address it was registered on.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: existingPasskeys.map((p) => ({ id: p.id }))
  });
  const challengeId = storeChallenge(options.challenge, user.id, user.username);
  return { challengeId, options };
}

/** Verify a registration response and return the credential to store. */
async function verifyRegistration(userId, challengeId, response, origin, rpID) {
  const c = takeChallenge(challengeId);
  if (!c || c.userId !== userId) {
    return { ok: false, error: 'Registration session expired — please try again.' };
  }
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Could not verify the passkey.' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'Passkey verification failed.' };
  }
  const cred = verification.registrationInfo.credential;
  const publicKey =
    typeof cred.publicKey === 'string'
      ? cred.publicKey
      : Buffer.from(cred.publicKey).toString('base64url');
  return {
    ok: true,
    credential: {
      id: cred.id,
      publicKey,
      counter: Number(cred.counter) || 0,
      transports: Array.isArray(cred.transports) ? cred.transports : []
    }
  };
}

/** Build the options for navigator.credentials.get(...). */
async function startLogin(rpID, passkeys) {
  // Omit allowCredentials entirely when there are none, so the browser
  // offers every passkey saved for this RP (an EMPTY array is rejected by
  // some browsers).
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.length
      ? passkeys.map((p) => ({ id: p.id, transports: p.transports || [] }))
      : undefined,
    userVerification: 'preferred'
  });
  const challengeId = storeChallenge(options.challenge, null, null);
  return { challengeId, options, allowed: passkeys.length };
}

/**
 * Verify a login assertion, then return the account that owns the passkey.
 * Caller is expected to create the session cookie on success.
 */
async function verifyLogin(challengeId, response, origin, rpID, usersStore) {
  const c = takeChallenge(challengeId);
  if (!c) return { ok: false, error: 'Login session expired — please try again.' };
  if (!response || typeof response.id !== 'string') {
    return { ok: false, error: 'Invalid passkey response.' };
  }
  const user = usersStore.getUserByPasskeyId(response.id);
  if (!user) return { ok: false, error: 'No account uses that passkey.' };
  const passkey = usersStore.getPasskeyRecord(user.id, response.id);
  if (!passkey) return { ok: false, error: 'No account uses that passkey.' };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: c.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        // v13's WebAuthnCredential.publicKey is a Uint8Array of the raw COSE
        // bytes — NOT a base64url string. We store it base64url (JSON-safe);
        // decode it back here. Passing the string makes isoCBOR.decodeFirst
        // build a zero-length array, which throws "No data" (the bug where
        // passkey login failed even though registration worked).
        publicKey: Buffer.from(passkey.publicKey, 'base64url'),
        counter: Number(passkey.counter) || 0,
        transports: passkey.transports || []
      },
      requireUserVerification: false
    });
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'Passkey verification failed.' };
  }
  if (!verification.verified) return { ok: false, error: 'Passkey verification failed.' };

  // Replay protection: persist the authenticator's new signature counter.
  usersStore.savePasskeyCounter(user.id, passkey.id, verification.authenticationInfo.newCounter);
  return { ok: true, user: { id: user.id, username: user.username, role: user.role } };
}

module.exports = {
  rpIDFor,
  originFor,
  startRegistration,
  verifyRegistration,
  startLogin,
  verifyLogin
};
