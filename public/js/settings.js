'use strict';

/* ============================================================
   MineBot — Settings page logic
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  accountUsername: $('account-username'),
  accountRole: $('account-role'),
  accountNote: $('account-note'),
  adminAccounts: $('admin-accounts'),
  accountsList: $('accounts-list'),
  pwdForm: $('pwd-form'),
  curPwd: $('cur-pwd'),
  newPwd: $('new-pwd'),
  confPwd: $('conf-pwd'),
  logoutBtns: [$('logout-btn'), $('logout-btn-2')],
  userBadge: $('user-badge'),
  toasts: $('toasts'),
  passkeysList: $('passkeys-list'),
  passkeyAddBtn: $('passkey-add-btn'),
  passkeysUnsupported: $('passkeys-unsupported'),
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  connPillSidebar: $('conn-pill-sidebar'),
  connPillMobile: $('conn-pill-mobile')
};

let me = null;

/* ---------- Auth ---------- */

async function init() {
  const res = await fetch('/api/auth/me');
  const data = await res.json();
  if (!data.ok) {
    window.location.replace('/login.html');
    return;
  }
  me = data.user;

  els.accountUsername.textContent = me.username;
  els.accountRole.textContent = me.role.toUpperCase();
  els.accountRole.className = 'badge ' + (me.role === 'admin' ? 'badge-emerald' : 'badge-amber');
  els.accountNote.textContent =
    me.role === 'admin'
      ? 'Full control: change bot settings, reconnect, and manage accounts.'
      : 'Limited role: can only start and stop the bot.';

  els.userBadge.innerHTML = mbIco('user') + ` ${me.username} · ${me.role === 'admin' ? 'Admin' : 'Guest'}`;

  if (me.role === 'admin') {
    await loadUsers();
    initAI();
  } else {
    els.adminAccounts.classList.add('hidden');
    const aiConfig = document.getElementById('ai-config');
    const aiBehaviour = document.getElementById('ai-behaviour');
    if (aiConfig) aiConfig.classList.add('hidden');
    if (aiBehaviour) aiBehaviour.classList.add('hidden');
  }

  initPasskeys();
}

/* ---------- Admin: manage accounts ---------- */

async function loadUsers() {
  const res = await fetch('/api/auth/users');
  const data = await res.json();
  if (!data.ok) return;
  els.accountsList.innerHTML = '';
  for (const u of data.users) els.accountsList.appendChild(renderAccountCard(u));
}

function renderAccountCard(u) {
  const card = document.createElement('div');
  card.className = 'rounded-xl bg-white/[0.03] border border-white/5 p-4 animate-fade-up';

  const isSelf = u.id === me.id;
  const unameId = `uname-${u.id}`;
  const pwdId = `pwd-${u.id}`;

  card.innerHTML = `
    <div class="flex items-center justify-between">
      <p class="text-sm font-bold text-white truncate">${escapeHtml(u.username)}${isSelf ? ' <span class="text-slate-400 font-normal">(you)</span>' : ''}</p>
      <span class="badge ${u.role === 'admin' ? 'badge-emerald' : 'badge-amber'} shrink-0">${u.role.toUpperCase()}</span>
    </div>
    <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label class="label" for="${unameId}">New username</label>
        <input id="${unameId}" class="input" placeholder="${escapeHtml(u.username)}" maxlength="24" />
      </div>
      ${isSelf ? '' : `
      <div>
        <label class="label" for="${pwdId}">New password</label>
        <input id="${pwdId}" type="password" class="input" placeholder="Leave blank to keep" minlength="4" />
      </div>`}
    </div>
    <div class="mt-3 flex flex-wrap gap-2 items-center">
      <button class="btn btn-ghost text-xs px-3 py-2" data-act="username">Update username</button>
      ${isSelf ? '<p class="text-xs text-slate-400">Change your own password with the form below.</p>' : `<button class="btn btn-ghost text-xs px-3 py-2" data-act="password">Update password</button>`}
    </div>`;

  card.querySelector('[data-act="username"]').addEventListener('click', () =>
    changeUsername(u.id, card.querySelector(`#${unameId}`))
  );
  if (!isSelf) {
    card.querySelector('[data-act="password"]').addEventListener('click', () =>
      changePassword(u.id, card.querySelector(`#${pwdId}`))
    );
  }

  return card;
}

async function changeUsername(id, input) {
  const newUsername = input.value.trim();
  if (!newUsername) return toast('Type a new username first.', 'error');
  const res = await fetch('/api/auth/change-username', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: id, newUsername })
  });
  const data = await res.json();
  if (data.ok) {
    toast('Username updated');
    await loadUsers();
  } else {
    toast(data.error || 'Could not update the username.', 'error');
  }
}

async function changePassword(id, input) {
  const newPassword = input.value;
  if (!newPassword) return toast('Type a new password first.', 'error');
  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: id, newPassword })
  });
  const data = await res.json();
  if (data.ok) {
    toast('Password updated');
    input.value = '';
  } else {
    toast(data.error || 'Could not update the password.', 'error');
  }
}

/* ---------- Change my password ---------- */

els.pwdForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (els.newPwd.value !== els.confPwd.value) return toast('New passwords do not match.', 'error');

  const res = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currentPassword: els.curPwd.value,
      newPassword: els.newPwd.value
    })
  });
  const data = await res.json();
  if (data.ok) {
    toast('Password changed successfully');
    els.pwdForm.reset();
  } else {
    toast(data.error || 'Could not change the password.', 'error');
  }
});

/* ---------- Passkeys (WebAuthn) ---------- */

// @simplewebauthn/server sends options with binary fields (challenge,
// user.id, excludeCredentials[].id) as base64url STRINGS, but the
// browser's navigator.credentials.* APIs need ArrayBuffer/ArrayBufferView.
// Decode before calling the browser, encode back when sending the response.
function b64urlToBuf(b64url) {
  let b64 = String(b64url).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Make the server's registration options browser-ready.
function prepRegOptions(o) {
  const out = Object.assign({}, o);
  if (out.challenge) out.challenge = b64urlToBuf(out.challenge);
  if (out.user && out.user.id) out.user = Object.assign({}, out.user, { id: b64urlToBuf(out.user.id) });
  if (Array.isArray(out.excludeCredentials)) {
    out.excludeCredentials = out.excludeCredentials.map((c) =>
      Object.assign({}, c, { id: b64urlToBuf(c.id) })
    );
  }
  return out;
}

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function passkeySupported() {
  // WebAuthn needs a secure context (HTTPS or localhost / 127.0.0.1).
  // On a LAN IP like http://192.168.x.x the browser silently blocks it.
  return (
    window.isSecureContext &&
    !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create)
  );
}

function passkeyBlockedReason() {
  if (window.isSecureContext) return null;
  const here = window.location.hostname;
  const isLan = here !== 'localhost' && here !== '127.0.0.1' && !window.location.protocol.startsWith('https');
  return isLan
    ? `Passkeys are blocked on this address (${here}). Open the dashboard as http://localhost:3000 (or HTTPS) to set up passkeys.`
    : 'Passkeys need a secure connection (HTTPS or localhost) and a modern browser.';
}

// Registration response shape (@simplewebauthn/server RegistrationResponseJSON).
function regCredToJSON(cred) {
  const json = {
    id: cred.id,
    rawId: bufToB64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufToB64url(cred.response.clientDataJSON),
      attestationObject: bufToB64url(cred.response.attestationObject)
    },
    clientExtensionResults:
      typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : {}
  };
  if (cred.response.getTransports) {
    const t = cred.response.getTransports();
    if (t && t.length) json.response.transports = t;
  }
  return json;
}

function initPasskeys() {
  const blocked = passkeyBlockedReason();
  if (blocked) {
    if (els.passkeysUnsupported) {
      els.passkeysUnsupported.innerHTML = mbIco('alert-triangle') + ' ' + blocked;
      els.passkeysUnsupported.classList.remove('hidden');
    }
    if (els.passkeyAddBtn) els.passkeyAddBtn.disabled = true;
    return;
  }
  if (els.passkeyAddBtn) els.passkeyAddBtn.addEventListener('click', addPasskey);
  loadPasskeys();
}

async function loadPasskeys() {
  if (!els.passkeysList) return;
  const res = await fetch('/api/auth/passkeys');
  const data = await res.json();
  if (!data.ok) return;
  const list = data.passkeys || [];
  els.passkeysList.innerHTML = '';
  if (!list.length) {
    els.passkeysList.innerHTML =
      '<p class="text-sm text-slate-500 py-5 text-center border border-dashed border-white/10 rounded-xl">No passkeys yet — add one to sign in without a password.</p>';
    return;
  }
  for (const p of list) els.passkeysList.appendChild(renderPasskeyCard(p));
}

function renderPasskeyCard(p) {
  const card = document.createElement('div');
  card.className = 'rounded-xl bg-white/[0.03] border border-white/5 p-4 flex flex-wrap items-center justify-between gap-3 animate-fade-up';
  const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—';
  const transports = p.transports && p.transports.length ? ' · ' + escapeHtml(p.transports.join(', ')) : '';
  card.innerHTML = `
    <div class="min-w-0">
      <p class="text-sm font-bold text-white truncate">${mbIco('key')} ${escapeHtml(p.name || 'Passkey')}</p>
      <p class="text-[11px] text-slate-500 mt-1">Added ${escapeHtml(date)}${transports}</p>
    </div>
    <button class="btn btn-ghost text-xs px-3 py-2 text-red-300 shrink-0" data-act="remove">${mbIco('trash')} Remove</button>`;
  card.querySelector('[data-act="remove"]').addEventListener('click', () => removePasskey(p.id));
  return card;
}

async function addPasskey() {
  const blocked = passkeyBlockedReason();
  if (blocked) return toast(blocked, 'error');
  if (!passkeySupported()) return toast('Passkeys are not supported in this browser.', 'error');
  try {
    const startRes = await fetch('/api/auth/passkey/register/start', { method: 'POST' });
    const start = await startRes.json();
    if (!start.ok || !start.options) return toast((start && start.error) || 'Could not start passkey setup.', 'error');
    const cred = await navigator.credentials.create({ publicKey: prepRegOptions(start.options) });
    const verifyRes = await fetch('/api/auth/passkey/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: start.challengeId, credential: regCredToJSON(cred), name: '' })
    });
    const data = await verifyRes.json();
    if (data.ok) {
      toast('Passkey added — use it to sign in next time', 'success');
      await loadPasskeys();
    } else {
      toast(data.error || 'Could not save the passkey.', 'error');
    }
  } catch (err) {
    if (err && err.name === 'NotAllowedError') {
      toast('Passkey setup was cancelled — or a passkey already exists for this address. Passkeys are tied to the exact address you are on (localhost vs 127.0.0.1 vs your Render URL).', 'error');
    } else if (err && err.name !== 'AbortError') {
      toast((err && err.message) || 'Could not set up the passkey.', 'error');
    }
  }
}

async function removePasskey(id) {
  if (!confirm('Remove this passkey? You will need your password (or another passkey) to sign in.')) return;
  const res = await fetch('/api/auth/passkeys/' + encodeURIComponent(id), { method: 'DELETE' });
  const data = await res.json();
  if (data.ok) {
    toast('Passkey removed');
    await loadPasskeys();
  } else {
    toast(data.error || 'Could not remove the passkey.', 'error');
  }
}

/* ---------- Logout ---------- */

for (const btn of els.logoutBtns) {
  if (btn) btn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/login.html');
  });
}

/* ---------- Mobile sidebar ---------- */

function closeSidebar() {
  els.sidebar.classList.add('-translate-x-full');
  els.sidebar.classList.remove('translate-x-0');
  els.overlay.classList.add('hidden');
}

els.menuBtn.addEventListener('click', () => {
  if (els.sidebar.classList.contains('translate-x-0')) closeSidebar();
  else {
    els.sidebar.classList.remove('-translate-x-full');
    els.sidebar.classList.add('translate-x-0');
    els.overlay.classList.remove('hidden');
  }
});

els.overlay.addEventListener('click', closeSidebar);

document.querySelectorAll('[data-nav]').forEach((link) => {
  link.addEventListener('click', () => closeSidebar());
});

/* ---------- Toasts ---------- */

function toast(message, type = 'info') {
  const icon = type === 'success' ? mbIco('circle-check') : type === 'error' ? mbIco('circle-x') : mbIco('info-circle');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="select-none">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

/* ---------- Helpers ---------- */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ============================================================
   AI Configuration (admin only)
   ============================================================ */

const AI_DEFAULT_MODELS = { gemini: 'gemini-3.6-flash', groq: 'llama-3.3-70b-versatile', nvidia: 'meta/llama-3.3-70b-instruct', custom: '' };
let editingAI = null; // key being edited, or null = new

const aiEls = {
  list: $('ai-keys-list'),
  addBtn: $('ai-add-key'),
  modal: $('ai-modal'),
  modalTitle: $('ai-modal-title'),
  name: $('ai-name'),
  provider: $('ai-provider'),
  endpointWrap: $('ai-endpoint-wrap'),
  endpoint: $('ai-endpoint'),
  apiKey: $('ai-key'),
  model: $('ai-model'),
  inputTokens: $('ai-input-tokens'),
  outputTokens: $('ai-output-tokens'),
  tokenHint: $('ai-token-hint'),
  saveBtn: $('ai-save'),
  cancelBtn: $('ai-cancel'),
  closeBtn: $('ai-modal-close'),
  prompt: $('ai-prompt'),
  usePrefix: $('ai-use-prefix'),
  prefixChar: $('ai-prefix-char'),
  mcChat: $('ai-mc-chat'),
  toolMode: $('ai-tool-mode'),
  autoApprove: $('ai-auto-approve'),
  behaviourSave: $('ai-behaviour-save')
};

function initAI() {
  loadAIKeys();
  loadAISettings();

  aiEls.addBtn.addEventListener('click', () => openAIModal());
  aiEls.cancelBtn.addEventListener('click', closeAIModal);
  aiEls.closeBtn.addEventListener('click', closeAIModal);
  aiEls.modal.addEventListener('click', (e) => {
    if (e.target === aiEls.modal || e.target.id === 'ai-modal-backdrop') closeAIModal();
  });
  aiEls.provider.addEventListener('change', onAIProviderChange);
  aiEls.saveBtn.addEventListener('click', saveAIKey);
  aiEls.behaviourSave.addEventListener('click', saveAIBehaviour);
}

function onAIProviderChange() {
  const p = aiEls.provider.value;
  aiEls.endpointWrap.classList.toggle('hidden', p !== 'custom');
  // Swap the model to the best free default for this provider, but only
  // when the field is empty or still shows a provider default — a model
  // the user typed is kept.
  const cur = aiEls.model.value.trim();
  const isDefault = !cur || Object.values(AI_DEFAULT_MODELS).includes(cur);
  if (isDefault) aiEls.model.value = AI_DEFAULT_MODELS[p] || '';

  // Show the recommended token defaults for this provider (same values the
  // fields pre-fill with when ADDING a key — editing keeps the saved values).
  const rec = {
    gemini: 'Gemini — 131,072 input · 8,192 output (free tier supports up to 1M context; 131K is a great balance of memory vs speed).',
    groq: 'Groq — 131,072 input · 8,192 output (llama-3.3-70b has a 131K context window, so 131K uses it fully).',
    nvidia: 'NVIDIA NIM — 131,072 input · 4,096 output (meta/llama-3.3-70b-instruct has a 128K context; NIM caps replies at 4K tokens on the free tier).',
    custom: 'Custom — 131,072 input · 8,192 output (safe for most OpenAI-compatible endpoints; lower if your provider caps lower).'
  }[p] || '';
  if (aiEls.tokenHint) aiEls.tokenHint.textContent = 'Recommended: ' + rec;
}

function openAIModal(key = null) {
  editingAI = key;
  aiEls.modalTitle.textContent = key ? `Edit “${key.name}”` : 'Add AI Key';
  aiEls.name.value = key ? key.name : '';
  aiEls.provider.value = key ? key.provider : 'gemini';
  aiEls.endpoint.value = key ? key.endpoint : '';
  aiEls.apiKey.value = key ? key.apiKey : '';
  aiEls.model.value = key ? key.model : AI_DEFAULT_MODELS[key ? key.provider : 'gemini'];
  // Defaults are shown when ADDING a new key; when editing, the key's own
  // saved values are shown. Coerce to valid numbers so old keys without
  // token fields (or NaN input) always fall back to the defaults instead of
  // silently saving nothing.
  const validTok = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Number(v) : dflt);
  // New keys pre-fill the recommended defaults for their provider; editing
  // always shows the key's own saved values.
  const addDefaults = {
    gemini: [131072, 8192],
    groq: [131072, 8192],
    nvidia: [131072, 4096],
    custom: [131072, 8192]
  }[key ? key.provider : 'gemini'] || [131072, 8192];
  aiEls.inputTokens.value = key ? validTok(key.maxInputTokens, 131072) : addDefaults[0];
  aiEls.outputTokens.value = key ? validTok(key.maxOutputTokens, 8192) : addDefaults[1];
  onAIProviderChange();
  aiEls.modal.classList.remove('hidden');
  aiEls.modal.classList.add('flex');
  aiEls.name.focus();
}

function closeAIModal() {
  aiEls.modal.classList.add('hidden');
  aiEls.modal.classList.remove('flex');
  editingAI = null;
}

async function saveAIKey() {
  const body = {
    name: aiEls.name.value.trim(),
    provider: aiEls.provider.value,
    endpoint: aiEls.endpoint.value.trim(),
    apiKey: aiEls.apiKey.value.trim(),
    model: aiEls.model.value.trim(),
    maxInputTokens: Number(aiEls.inputTokens.value) || 131072,
    maxOutputTokens: Number(aiEls.outputTokens.value) || 8192
  };
  const url = editingAI ? `/api/ai/keys/${encodeURIComponent(editingAI.name)}` : '/api/ai/keys';
  const res = await fetch(url, {
    method: editingAI ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.ok) {
    toast(editingAI ? 'AI key updated' : 'AI key saved', 'success');
    closeAIModal();
    await loadAIKeys();
  } else {
    toast(data.error || 'Could not save the AI key.', 'error');
  }
}

async function loadAIKeys() {
  const res = await fetch('/api/ai/keys');
  const data = await res.json();
  if (!data.ok) return;
  const list = data.keys || [];
  aiEls.list.innerHTML = '';
  if (!list.length) {
    aiEls.list.innerHTML =
      '<p class="text-sm text-slate-500 py-6 text-center border border-dashed border-white/10 rounded-xl">No AI keys yet — add one to chat with your bot.</p>';
    return;
  }
  for (const k of list) aiEls.list.appendChild(renderAIKeyCard(k));
}

function renderAIKeyCard(k) {
  const card = document.createElement('div');
  card.className = 'rounded-xl bg-white/[0.03] border border-white/5 p-4 animate-fade-up';
  const prov = { gemini: 'Gemini', groq: 'Groq', nvidia: 'NVIDIA NIM', custom: 'Custom' }[k.provider] || k.provider;
  card.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-sm font-bold text-white truncate">${mbIco('brain')} ${escapeHtml(k.name)}</p>
        <p class="text-xs text-slate-500 mt-1 truncate">
          <span class="badge badge-emerald">${prov}</span>
          <span class="ml-2">${escapeHtml(k.model)}</span>
        </p>
        <p class="text-[11px] text-slate-600 mt-1.5">in: ${Number(k.maxInputTokens).toLocaleString()} · out: ${Number(k.maxOutputTokens).toLocaleString()} tokens</p>
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        <button class="btn btn-ghost text-xs px-3 py-2" data-act="copy">${mbIco('clipboard')} Copy</button>
        <button class="btn btn-ghost text-xs px-3 py-2" data-act="test">${mbIco('flask')} Test</button>
        <button class="btn btn-ghost text-xs px-3 py-2" data-act="edit">${mbIco('edit')} Edit</button>
        <button class="btn btn-ghost text-xs px-3 py-2 text-red-300" data-act="delete">${mbIco('trash')} Delete</button>
      </div>
    </div>`;

  card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(k.apiKey);
      toast('API key copied', 'success');
    } catch (_) {
      toast('Could not copy — use Edit to view the key.', 'error');
    }
  });

  card.querySelector('[data-act="test"]').addEventListener('click', async () => {
    const btn = card.querySelector('[data-act="test"]');
    btn.disabled = true;
    btn.innerHTML = mbIco('clock') + ' Testing…';
    try {
      const res = await fetch(`/api/ai/keys/${encodeURIComponent(k.name)}/test`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) toast(`${mbIco('circle-check')} ${k.provider} answered in ${data.latencyMs}ms (${data.model})`, 'success');
      else toast(`Test failed: ${data.error}`, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = mbIco('flask') + ' Test';
    }
  });

  card.querySelector('[data-act="edit"]').addEventListener('click', () => openAIModal(k));

  card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete AI key "${k.name}"?`)) return;
    const res = await fetch(`/api/ai/keys/${encodeURIComponent(k.name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) {
      toast('AI key deleted');
      await loadAIKeys();
    } else {
      toast(data.error || 'Could not delete the key.', 'error');
    }
  });

  return card;
}

async function loadAISettings() {
  const res = await fetch('/api/ai/settings');
  const data = await res.json();
  if (!data.ok) return;
  const s = data.settings;
  aiEls.prompt.value = s.prompt || '';
  aiEls.usePrefix.checked = !!s.usePrefix;
  aiEls.prefixChar.value = s.prefixChar || '!';
  aiEls.mcChat.checked = !!s.mcChatAI;
  aiEls.toolMode.value = s.toolMode || 'auto';
  aiEls.autoApprove.checked = s.autoApprove !== false; // default ON
}

async function saveAIBehaviour() {
  const res = await fetch('/api/ai/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: aiEls.prompt.value,
      usePrefix: aiEls.usePrefix.checked,
      prefixChar: aiEls.prefixChar.value,
      mcChatAI: aiEls.mcChat.checked,
      toolMode: aiEls.toolMode.value,
      autoApprove: aiEls.autoApprove.checked
    })
  });
  const data = await res.json();
  if (data.ok) toast('AI behaviour saved', 'success');
  else toast(data.error || 'Could not save the AI behaviour.', 'error');
}

/* ---------- Boot ---------- */

init();
