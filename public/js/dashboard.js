'use strict';

/* ============================================================
   MineBot Dashboard — client logic
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  form: $('setup-form'),
  botName: $('bot-name'),
  serverIp: $('server-ip'),
  serverPort: $('server-port'),
  mcVersion: $('mc-version'),
  saveBtn: $('save-btn'),
  lastSaved: $('last-saved'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  reconnectBtn: $('reconnect-btn'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  controlBadge: $('control-state-badge'),
  botFace: $('bot-face'),
  targetLine: $('target-line'),
  lastMessage: $('last-message'),
  spinner: $('connecting-spinner'),
  toasts: $('toasts'),
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  connPillSidebar: $('conn-pill-sidebar'),
  connPillMobile: $('conn-pill-mobile'),
  userBadge: $('user-badge'),
  logoutBtn: $('logout-btn'),
  randomNameBtn: $('random-name-btn'),
  historyBox: $('server-history'),
  historyEmpty: $('history-empty'),
  loginEnabled: $('login-enabled'),
  loginFields: $('login-fields'),
  loginPassword: $('login-password'),
  loginAutoDetect: $('login-auto-detect'),
  loginDelay: $('login-delay')
};

const STATE_META = {
  stopped:      { text: 'STOPPED',      pill: '',           badge: 'badge-slate', face: 'robot',
                 hint: 'Bot is stopped. Configure it above and press Start.' },
  connecting:   { text: 'CONNECTING',   pill: 'connecting',  badge: 'badge-amber', face: 'plug',
                 hint: 'Connecting to the server…' },
  connected:    { text: 'IN SERVER',    pill: 'connected',   badge: 'badge-green', face: 'circle-check',
                 hint: 'Bot is online in the server.' },
  disconnected: { text: 'DISCONNECTED', pill: 'disconnected', badge: 'badge-red', face: 'moon',
                 hint: 'Bot lost connection to the server.' },
  error:        { text: 'ERROR',        pill: 'error',       badge: 'badge-red', face: 'alert-triangle',
                 hint: '' }
};

let savedConfig = null;
let versionsLoaded = false;
let botState = null; // latest bot:state snapshot (used to re-render after auth UI resolves)
let serverHistoryList = []; // latest server history (re-rendered when auth UI resolves)

/* ---------- Auth ---------- */

let currentUser = null;
const isGuest = () => currentUser && currentUser.role === 'guest';

fetch('/api/auth/me')
  .then((r) => r.json())
  .then((d) => {
    if (!d.ok) {
      window.location.replace('/login.html');
      return;
    }
    currentUser = d.user;
    applyAuthUI();
  })
  .catch(() => window.location.replace('/login.html'));

function applyAuthUI() {
  els.userBadge.innerHTML = currentUser
    ? mbIco('user') + ' ' + escapeHtml(currentUser.username + ' · ' + (currentUser.role === 'admin' ? 'Admin' : 'Guest'))
    : '…';
  if (isGuest()) {
    // Guests may only start/stop the bot — settings stay admin-locked.
    els.botName.disabled = true;
    els.serverIp.disabled = true;
    els.serverPort.disabled = true;
    els.mcVersion.disabled = true;
    els.saveBtn.disabled = true;
    els.saveBtn.title = 'Only admins can change bot settings.';
    els.reconnectBtn.title = 'Only admins can reconnect.';
    els.randomNameBtn.disabled = true;
    els.randomNameBtn.title = 'Only admins can change bot settings.';
    els.loginEnabled.disabled = true;
    els.loginPassword.disabled = true;
    els.loginAutoDetect.disabled = true;
    els.loginDelay.disabled = true;
    // Re-render history without remove buttons for guests.
    renderHistory(serverHistoryList);
    if (botState) renderState(botState);
  }
}

els.logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.replace('/login.html');
});

/* ---------- Socket.io ---------- */

const socket = io();

socket.on('connect', () => {
  setConnPills(true);
});

socket.on('disconnect', () => {
  setConnPills(false);
});

socket.on('config:loaded', (cfg) => {
  savedConfig = cfg;
  fillForm(cfg);
});

socket.on('config:updated', (cfg) => {
  savedConfig = cfg;
  fillForm(cfg);
  toast('Settings saved', 'success');
});

socket.on('config:history', (list) => {
  renderHistory(list);
});

socket.on('bot:state', (snap) => {
  renderState(snap);
});



/* ---------- Random bot name ---------- */

const RANDOM_PREFIXES = ['Crafty', 'Pixel', 'Blocky', 'Redstone', 'Obsidian', 'Creeper', 'Ender', 'Nether', 'Diamond', 'Golden', 'Lucky', 'Super', 'Silent', 'Swift', 'Brave', 'Frosty', 'Ember', 'Turbo', 'Mega', 'Lava'];
const RANDOM_SUFFIXES = ['Fox', 'Wolf', 'Dragon', 'Knight', 'Miner', 'Steve', 'Alex', 'Ninja', 'Wizard', 'Hunter', 'Rider', 'Titan', 'Ghost', 'Storm', 'Blaze', 'Panda', 'Bunny', 'Cactus', 'Pig', 'Slime'];

function randomBotName() {
  const a = RANDOM_PREFIXES[Math.floor(Math.random() * RANDOM_PREFIXES.length)];
  const b = RANDOM_SUFFIXES[Math.floor(Math.random() * RANDOM_SUFFIXES.length)];
  const n = Math.floor(Math.random() * 90) + 10; // two digits, 10–99
  return a + b + n;
}

els.randomNameBtn.addEventListener('click', () => {
  if (els.randomNameBtn.disabled) return;
  els.botName.value = randomBotName();
  toast('Random name generated');
});

/* ---------- Version dropdown (single source of truth on the server) ---------- */

fetch('/api/versions')
  .then((r) => r.json())
  .then((list) => {
    els.mcVersion.innerHTML = list.map((v) => `<option value="${v}">${v}</option>`).join('');
    versionsLoaded = true;
    if (savedConfig && savedConfig.version) els.mcVersion.value = savedConfig.version;
  })
  .catch(() => toast('Could not load Minecraft versions from the server', 'error'));

/* ---------- Form ---------- */

function toggleLoginFields() {
  els.loginFields.classList.toggle('hidden', !els.loginEnabled.checked);
}

els.loginEnabled.addEventListener('change', toggleLoginFields);

function fillForm(cfg) {
  els.botName.value = cfg.botName || '';
  els.serverIp.value = cfg.serverIp || '';
  els.serverPort.value = cfg.serverPort || 25565;
  if (versionsLoaded && cfg.version && [...els.mcVersion.options].some((o) => o.value === cfg.version)) {
    els.mcVersion.value = cfg.version;
  }
  els.lastSaved.textContent = cfg.savedAt ? formatTime(cfg.savedAt) : 'never';
  els.targetLine.textContent = `${cfg.botName || 'Bot'} → ${cfg.serverIp || '?'}:${cfg.serverPort || '?'}`;

  // Server login (AuthMe) fields.
  els.loginEnabled.checked = !!cfg.loginEnabled;
  els.loginAutoDetect.checked = cfg.loginAutoDetect !== false; // default on
  els.loginDelay.value = cfg.loginDelaySeconds || 5;
  els.loginPassword.value = cfg.loginPassword || '';
  toggleLoginFields();

  renderHistory(cfg.serverHistory || []);
}

function readForm() {
  return {
    botName: els.botName.value.trim(),
    serverIp: els.serverIp.value.trim(),
    serverPort: Number(els.serverPort.value),
    version: els.mcVersion.value,
    loginEnabled: els.loginEnabled.checked,
    loginPassword: els.loginPassword.value.trim(),
    loginAutoDetect: els.loginAutoDetect.checked,
    loginDelaySeconds: Number(els.loginDelay.value) || 5
  };
}

/* ---------- Server history ---------- */

function renderHistory(list) {
  serverHistoryList = Array.isArray(list) ? list : [];
  els.historyBox.innerHTML = '';
  if (!serverHistoryList.length) {
    els.historyBox.appendChild(els.historyEmpty);
    return;
  }
  for (const h of serverHistoryList) {
    const chip = document.createElement('div');
    chip.className =
      'group flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] pl-3 pr-1.5 py-1.5 text-xs cursor-pointer transition-all hover:border-emerald-400/40 hover:bg-emerald-500/5 animate-fade-up';
    chip.innerHTML = `
      <span class="font-bold text-slate-200">${escapeHtml(h.ip)}<span class="text-slate-500">:${escapeHtml(String(h.port))}</span></span>
      ${h.version ? `<span class="text-[10px] uppercase tracking-wide text-slate-500">MC ${escapeHtml(h.version)}</span>` : ''}
      ${isGuest() ? '' : '<button data-rm class="w-5 h-5 grid place-items-center rounded-full text-slate-500 hover:text-red-300 hover:bg-red-500/10 transition-colors shrink-0" title="Remove from history">' + mbIco('x') + '</button>'}
    `;
    chip.addEventListener('click', (e) => {
      if (e.target.closest('[data-rm]')) return;
      els.serverIp.value = h.ip;
      els.serverPort.value = h.port;
      if (versionsLoaded && [...els.mcVersion.options].some((o) => o.value === h.version)) {
        els.mcVersion.value = h.version;
      }
      toast(`Loaded ${h.ip}:${h.port}`);
    });
    const rm = chip.querySelector('[data-rm]');
    if (rm) {
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('config:history:remove', { ip: h.ip, port: h.port }, (res) => {
          if (res && res.ok) toast('Removed from history');
          else toast((res && res.errors && res.errors[0]) || 'Could not remove from history.', 'error');
        });
      });
    }
    els.historyBox.appendChild(chip);
  }
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = readForm();
  setSaveBusy(true);
  socket.emit('config:save', data, (res) => {
    setSaveBusy(false);
    if (res && res.ok) {
      toast('Settings saved', 'success');
    } else {
      const msg = res && res.errors ? res.errors.join(' ') : 'Could not save settings.';
      toast(msg, 'error');
    }
  });
});

function setSaveBusy(busy) {
  els.saveBtn.disabled = busy;
  els.saveBtn.style.opacity = busy ? '1' : ''; // keep readable while disabled
  els.saveBtn.innerHTML = busy
    ? '<div class="spinner" style="width:1.1rem;height:1.1rem;border-width:2px"></div> Saving…'
    : '<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/></svg> Save Settings';
}

/* ---------- Bot controls ---------- */

els.startBtn.addEventListener('click', () => {
  socket.emit('bot:start', readForm(), (res) => {
    if (res && !res.ok) {
      toast(res.errors ? res.errors.join(' ') : 'Could not start the bot', 'error');
    }
  });
});

els.stopBtn.addEventListener('click', () => socket.emit('bot:stop'));

els.reconnectBtn.addEventListener('click', () => socket.emit('bot:reconnect'));

function renderState(snap) {
  botState = snap;
  const meta = STATE_META[snap.state] || STATE_META.stopped;

  els.statusPill.className = 'status-pill animate-fade-up ' + meta.pill;
  els.statusText.textContent = meta.text;

  els.controlBadge.className = 'badge ' + meta.badge;
  els.controlBadge.textContent = meta.text;

  els.botFace.innerHTML = mbIco(meta.face);

  const running = snap.state === 'connecting' || snap.state === 'connected';
  els.startBtn.disabled = running;
  els.stopBtn.disabled = !running;
  els.reconnectBtn.disabled = isGuest() || !(snap.canReconnect || running);

  els.spinner.classList.toggle('hidden', snap.state !== 'connecting');

  if (snap.config) {
    els.targetLine.textContent = `${snap.config.botName} → ${snap.config.serverIp}:${snap.config.serverPort} (MC ${snap.config.version})`;
  }

  if (snap.state === 'error' && snap.lastError) {
    els.lastMessage.innerHTML = mbIco('alert-triangle') + ' ' + snap.lastError;
    els.lastMessage.className = 'text-xs text-red-400 mt-0.5';
  } else {
    els.lastMessage.textContent = meta.hint;
    els.lastMessage.className = 'text-xs text-slate-400 mt-0.5';
  }
}

/* ---------- Toasts ---------- */

function toast(message, type = 'info') {
  const icon = mbIco(type === 'success' ? 'circle-check' : type === 'error' ? 'x' : 'info-circle');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="select-none">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

/* ---------- Mobile sidebar ---------- */

function closeSidebar() {
  els.sidebar.classList.add('-translate-x-full');
  els.sidebar.classList.remove('translate-x-0');
  els.overlay.classList.add('hidden');
}

els.menuBtn.addEventListener('click', () => {
  const isOpen = els.sidebar.classList.contains('translate-x-0');
  if (isOpen) closeSidebar();
  else {
    els.sidebar.classList.remove('-translate-x-full');
    els.sidebar.classList.add('translate-x-0');
    els.overlay.classList.remove('hidden');
  }
});

els.overlay.addEventListener('click', closeSidebar);

document.querySelectorAll('[data-nav]').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('[data-nav]').forEach((n) => n.classList.remove('active'));
    link.classList.add('active');
    closeSidebar();
  });
});

/* ---------- Helpers ---------- */

function setConnPills(online) {
  const cls = online ? 'text-emerald-400' : 'text-slate-500';
  els.connPillSidebar.textContent = online ? '● Online' : '○ Offline';
  els.connPillSidebar.className = 'text-xs font-bold ' + cls;
  els.connPillMobile.textContent = online ? '●' : '○';
  els.connPillMobile.className = 'text-xs font-bold ' + cls;
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- Boot ---------- */

renderState({ state: 'stopped', config: null, lastError: null, hasConnected: false, canReconnect: false });
