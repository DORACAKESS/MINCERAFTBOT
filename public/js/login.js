'use strict';

/* ============================================================
   MineBot — login page logic
   ============================================================ */

const $ = (id) => document.getElementById(id);

const form = $('login-form');
const usernameEl = $('login-username');
const passwordEl = $('login-password');
const errorEl = $('login-error');
const btn = $('login-btn');
const passkeyBtn = $('passkey-btn');
const passkeyNote = $('passkey-note');

// Render's free tier sleeps after ~15 min of inactivity and takes up to a
// minute to wake up. A bare fetch() would hang with the button stuck on
// "Signing in…" with no feedback — give the request a generous timeout and
// tell the user what is happening instead.
function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 90000);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal })).finally(() =>
    clearTimeout(timer)
  );
}

// Already signed in? Skip the login page.
fetchWithTimeout('/api/auth/me', {}, 15000)
  .then((r) => r.json())
  .then((d) => {
    if (d.ok) window.location.replace('/');
  })
  .catch(() => {});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();
  setBusy(true);

  try {
    const res = await fetchWithTimeout('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: usernameEl.value.trim(),
        password: passwordEl.value
      })
    }, 90000);
    const data = await res.json();
    if (res.ok) {
      window.location.replace('/');
      return;
    }
    showError(data.error || 'Invalid username or password.');
  } catch (err) {
    if (err && err.name === 'AbortError') {
      showError(
        'The server is waking up (free hosts like Render sleep when idle and take up to a minute to start). Give it a moment and press Sign In again.'
      );
    } else {
      showError('Could not reach the server. Is it running?');
    }
  }

  setBusy(false);
});

function setBusy(busy) {
  btn.disabled = busy;
  btn.style.opacity = busy ? '1' : '';
  btn.innerHTML = busy
    ? '<div class="spinner" style="width:1.1rem;height:1.1rem;border-width:2px"></div> Signing in…'
    : 'Sign In';
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
  form.classList.remove('shake');
  void form.offsetWidth; // restart the animation
  form.classList.add('shake');
}

function hideError() {
  errorEl.classList.add('hidden');
}

/* ---------- Passkey (WebAuthn) sign-in ---------- */

// @simplewebauthn/server sends options with binary fields (challenge,
// allowCredentials[].id) as base64url STRINGS, but the browser's
// navigator.credentials.* APIs need them as ArrayBuffer/ArrayBufferView.
// Decode before calling the browser, encode back when sending the response.
function b64urlToBuf(b64url) {
  let b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Make the server's authentication options browser-ready.
function prepAuthOptions(o) {
  const out = Object.assign({}, o);
  if (out.challenge) out.challenge = b64urlToBuf(out.challenge);
  if (Array.isArray(out.allowCredentials)) {
    out.allowCredentials = out.allowCredentials.map((c) =>
      Object.assign({}, c, { id: b64urlToBuf(c.id) })
    );
  }
  return out;
}

// Convert a browser PublicKeyCredential into the JSON shape the server's
// @simplewebauthn/server expects (base64url-encoded fields).
function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function credToJSON(cred) {
  const json = {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      authenticatorData: bufToB64url(cred.response.authenticatorData),
      signature: bufToB64url(cred.response.signature)
    },
    clientExtensionResults:
      typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {}
  };
  if (cred.response.userHandle) json.response.userHandle = bufToB64url(cred.response.userHandle);
  return json;
}

function showPasskeyNote(msg) {
  passkeyNote.textContent = msg;
  passkeyNote.classList.remove('hidden');
}

// WebAuthn only works in a secure context (HTTPS or localhost / 127.0.0.1).
// On a LAN IP like http://192.168.x.x the browser blocks passkeys entirely
// and the page gets no error at all — so we detect it up front and explain.
function passkeySupported() {
  return (
    window.isSecureContext &&
    !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get)
  );
}

passkeyBtn.addEventListener('click', async () => {
  hideError();
  passkeyNote.classList.add('hidden');
  if (!passkeySupported()) {
    const here = window.location.hostname;
    const isLan = here !== 'localhost' && here !== '127.0.0.1' && !window.location.protocol.startsWith('https');
    return showPasskeyNote(
      isLan
        ? `Passkeys are blocked on this address (${here}). Open the dashboard as http://localhost:3000 (or HTTPS) and try again — passkeys are also tied to the exact address you registered them on.`
        : 'Passkeys need a secure connection (HTTPS or localhost) and a modern browser — use your password here instead.'
    );
  }
  passkeyBtn.disabled = true;
  try {
    // Pass the typed username (if any) so the server only offers that
    // account's passkeys — clearer prompt, fewer mismatches.
    const startRes = await fetch('/api/auth/passkey/login/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameEl.value.trim() })
    });
    const start = await startRes.json();
    if (!start.ok || !start.options) throw new Error((start && start.error) || 'Could not start passkey login.');
    if (usernameEl.value.trim() && start.allowed === false) {
      return showPasskeyNote(
        `No passkey is saved for “${usernameEl.value.trim()}” on this address. Passkeys are tied to the address they were created on (localhost vs 127.0.0.1 vs your Render URL) — add one in Settings while signed in on THIS address.`
      );
    }

    const cred = await navigator.credentials.get({ publicKey: prepAuthOptions(start.options) });
    const verifyRes = await fetch('/api/auth/passkey/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: start.challengeId, credential: credToJSON(cred) })
    });
    const data = await verifyRes.json();
    if (data.ok) {
      window.location.replace('/');
      return;
    }
    showError(data.error || 'Passkey sign-in failed.');
  } catch (err) {
    if (err && err.name === 'NotAllowedError') {
      showPasskeyNote(
        'No passkey matched on this address (or you cancelled). Passkeys only work on the exact address they were registered on — e.g. a passkey made on localhost will not appear on 127.0.0.1 or on Render. Sign in with your password, then add a passkey in Settings while on this address.'
      );
    } else if (err && err.name !== 'AbortError') {
      showError((err && err.message) || 'Passkey sign-in failed.');
    }
  } finally {
    passkeyBtn.disabled = false;
  }
});
