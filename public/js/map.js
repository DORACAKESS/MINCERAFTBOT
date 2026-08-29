'use strict';

/* ============================================================
   MineBot — 3D Map page logic
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  viewerFrame: $('viewer-frame'),
  viewerPlaceholder: $('viewer-placeholder'),
  viewerError: $('viewer-error'),
  viewerErrorText: $('viewer-error-text'),
  viewerUrl: $('viewer-url'),
  openFull: $('open-full'),
  refreshBtn: $('refresh-btn'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  targetLine: $('target-line'),
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  connPillSidebar: $('conn-pill-sidebar'),
  connPillMobile: $('conn-pill-mobile'),
  userBadge: $('user-badge'),
  logoutBtn: $('logout-btn')
};

const STATE_META = {
  stopped:      { text: 'STOPPED',      pill: '' },
  connecting:   { text: 'CONNECTING',   pill: 'connecting' },
  connected:    { text: 'IN SERVER',    pill: 'connected' },
  disconnected: { text: 'DISCONNECTED', pill: 'disconnected' },
  error:        { text: 'ERROR',        pill: 'error' }
};

/* ---------- Auth ---------- */

fetch('/api/auth/me')
  .then((r) => r.json())
  .then((d) => {
    if (!d.ok) {
      window.location.replace('/login.html');
      return;
    }
    els.userBadge.innerHTML = mbIco('user') + ` ${d.user.username} · ${d.user.role === 'admin' ? 'Admin' : 'Guest'}`;
  })
  .catch(() => window.location.replace('/login.html'));

els.logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.replace('/login.html');
});

/* ---------- Socket.io ---------- */

const socket = io();

socket.on('connect', () => setConnPills(true));
socket.on('disconnect', () => setConnPills(false));

socket.on('bot:state', (snap) => {
  const meta = STATE_META[snap.state] || STATE_META.stopped;
  els.statusPill.className = 'status-pill animate-fade-up ' + meta.pill;
  els.statusText.textContent = meta.text;
  els.targetLine.textContent = snap.config
    ? `${snap.config.botName} → ${snap.config.serverIp}:${snap.config.serverPort}`
    : 'No bot configured yet';
});

socket.on('viewer:state', (snap) => updateViewer(snap));

/* ---------- Viewer ---------- */

// The viewer lives on the SAME origin as the dashboard (single port), so the
// URL is simply our own origin + the viewer path — works locally AND on
// Render (where only one port is exposed).
function viewerUrl(snap) {
  return window.location.origin + (snap.url || '/viewer/');
}

function updateViewer(snap) {
  els.viewerUrl.textContent = snap.running ? '● Viewer active' : 'Viewer off';
  els.viewerUrl.className = 'badge ' + (snap.running ? 'badge-emerald' : 'badge-slate');
  els.openFull.classList.toggle('hidden', !snap.running);
  els.refreshBtn.classList.toggle('hidden', !snap.running);
  if (snap.running) {
    const url = viewerUrl(snap);
    els.openFull.href = url;
    els.viewerError.classList.add('hidden');
    els.viewerPlaceholder.classList.add('hidden');
    const frame = els.viewerFrame;
    if (frame.dataset.src !== url) {
      frame.dataset.src = url;
      frame.src = url;
    }
    frame.classList.remove('hidden');
  } else if (snap.error) {
    els.viewerFrame.classList.add('hidden');
    els.viewerPlaceholder.classList.add('hidden');
    els.viewerErrorText.textContent = snap.error;
    els.viewerError.classList.remove('hidden');
  } else {
    els.viewerFrame.classList.add('hidden');
    els.viewerError.classList.add('hidden');
    els.viewerPlaceholder.classList.remove('hidden');
  }
}

els.refreshBtn.addEventListener('click', () => {
  const frame = els.viewerFrame;
  // Same-origin iframe → a direct reload works.
  try {
    frame.contentWindow.location.reload();
    return;
  } catch (_) {
    /* cross-origin fallback below */
  }
  // Fallback: reset the src to force a full reload.
  const url = frame.dataset.src;
  if (!url) return;
  frame.src = 'about:blank';
  frame.dataset.src = '';
  frame.classList.add('hidden');
  setTimeout(() => {
    frame.dataset.src = url;
    frame.src = url;
    frame.classList.remove('hidden');
  }, 120);
});

/* ---------- WASD forwarding ----------
   The 3D canvas lives in an iframe. Keyboard events only reach it when the
   iframe has focus, so also forward the movement keys from this page — the
   viewer's patch listens for them via postMessage. */

const WALK_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'];

function forwardKey(e, down) {
  const k = e.key.toLowerCase();
  if (!WALK_KEYS.includes(k)) return;
  const frame = els.viewerFrame;
  if (frame && frame.contentWindow) {
    frame.contentWindow.postMessage({ __mbCtrl: { key: k, down } }, '*');
  }
}

window.addEventListener('keydown', (e) => forwardKey(e, true));
window.addEventListener('keyup', (e) => forwardKey(e, false));
window.addEventListener('blur', () => forwardKey({ key: 'shift' }, false));

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

/* ---------- Helpers ---------- */

function setConnPills(online) {
  const cls = online ? 'text-emerald-400' : 'text-slate-500';
  els.connPillSidebar.textContent = online ? '● Online' : '○ Offline';
  els.connPillSidebar.className = 'text-xs font-bold ' + cls;
  els.connPillMobile.textContent = online ? '●' : '○';
  els.connPillMobile.className = 'text-xs font-bold ' + cls;
}

/* ---------- Boot ---------- */

updateViewer({ running: false, url: '/viewer/', error: null });
