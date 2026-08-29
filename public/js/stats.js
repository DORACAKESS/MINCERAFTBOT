'use strict';

/* ============================================================
   MineBot — Statistics page logic
   Live vitals (bot:radar → health/food/position/facing/nearby),
   latency (bot:state), activity feed (bot:logs + bot:log),
   session totals (bot:stats) and dashboard-server stats
   (server:stats) — all over socket.io.
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  connPillSidebar: $('conn-pill-sidebar'),
  connPillMobile: $('conn-pill-mobile'),
  userBadge: $('user-badge'),
  logoutBtn: $('logout-btn'),
  statusPill: $('status-pill'),
  statusText: $('status-text'),
  targetLine: $('target-line'),
  latChip: $('lat-chip'),
  lastConnected: $('last-connected'),
  // Vitals
  vitalsPlaceholder: $('vitals-placeholder'),
  vitalsEmoji: $('vitals-emoji'),
  vitalsGrid: $('vitals-grid'),
  hpText: $('hp-text'),
  hpBar: $('hp-bar'),
  foodText: $('food-text'),
  foodBar: $('food-bar'),
  posX: $('pos-x'),
  posY: $('pos-y'),
  posZ: $('pos-z'),
  posYaw: $('pos-yaw'),
  facing: $('facing'),
  facingDesc: $('facing-desc'),
  nbPlayers: $('nb-players'),
  nbMobs: $('nb-mobs'),
  nbTotal: $('nb-total'),
  nbRadius: $('nb-radius'),
  latBig: $('lat-big'),
  latState: $('lat-state'),
  // Session
  sessions: $('st-sessions'),
  connected: $('st-connected'),
  uptime: $('st-uptime'),
  distance: $('st-distance'),
  mined: $('st-mined'),
  dropped: $('st-dropped'),
  attacks: $('st-attacks'),
  deaths: $('st-deaths'),
  // Feed
  feed: $('feed'),
  feedEmpty: $('feed-empty'),
  // Server
  svUptime: $('sv-uptime'),
  svNode: $('sv-node'),
  svMem: $('sv-mem'),
  svMemFill: $('sv-mem-fill')
};

const STATE_META = {
  stopped:      { text: 'STOPPED',      pill: '' },
  connecting:   { text: 'CONNECTING',   pill: 'connecting' },
  connected:    { text: 'IN SERVER',    pill: 'connected' },
  disconnected: { text: 'DISCONNECTED', pill: 'disconnected' },
  error:        { text: 'ERROR',        pill: 'error' }
};

const CARDINAL = ['South', 'South-West', 'West', 'North-West', 'North', 'North-East', 'East', 'South-East'];
const CARDINAL_SHORT = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];

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

socket.on('bot:state', renderState);
socket.on('bot:radar', renderVitals);
socket.on('bot:stats', renderSessionStats);
socket.on('server:stats', renderServerStats);
socket.on('bot:logs', (entries) => {
  if (Array.isArray(entries)) {
    entries.slice(-120).reverse().forEach(addFeedEntry);
  }
});
socket.on('bot:log', (entry) => addFeedEntry(entry));

/* ---------- Formatting ---------- */

function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  const h = Math.floor(s / 3600);
  return h + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function fmtDistance(blocks) {
  const n = Number(blocks) || 0;
  if (n < 1000) return Math.round(n) + ' m';
  return (n / 1000).toFixed(1) + ' km';
}

function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/* ---------- Bot state / latency ---------- */

function renderState(snap) {
  const state = (snap && snap.state) || 'stopped';
  const meta = STATE_META[state] || STATE_META.stopped;
  els.statusPill.className = 'status-pill animate-fade-up ' + meta.pill;
  els.statusText.textContent = meta.text;

  els.targetLine.textContent = snap.config
    ? `${snap.config.botName} → ${snap.config.serverIp}:${snap.config.serverPort}`
    : 'No bot configured yet';

  // Latency chip (header) + big latency (vitals card).
  const lat = typeof snap.latencyMs === 'number' ? Math.round(snap.latencyMs) : null;
  if (lat !== null) {
    els.latChip.innerHTML = mbIco('bolt') + ` ${lat} ms`;
    els.latChip.className = 'badge ' + latColor(lat) + ' shrink-0';
    els.latBig.textContent = lat;
    els.latState.textContent = latLabel(lat);
    els.latState.className = 'ml-auto text-[10px] font-bold uppercase tracking-wider ' +
      (lat < 80 ? 'text-emerald-400' : lat < 200 ? 'text-amber-400' : 'text-rose-400');
  } else {
    els.latChip.innerHTML = mbIco('bolt') + ' —';
    els.latChip.className = 'badge badge-slate shrink-0';
    els.latBig.textContent = '—';
    els.latState.textContent = '';
  }

  // Vitals are only live while connected.
  if (state !== 'connected') {
    els.vitalsGrid.classList.add('hidden');
    els.vitalsPlaceholder.classList.remove('hidden');
    if (els.vitalsEmoji) els.vitalsEmoji.innerHTML = state === 'connecting' ? mbIco('refresh') : mbIco('moon');
  }
}

function latColor(ms) {
  if (ms < 80) return 'badge-emerald';
  if (ms < 200) return 'badge-amber';
  return 'badge-rose';
}

function latLabel(ms) {
  if (ms < 80) return 'Great';
  if (ms < 200) return 'OK';
  return 'Slow';
}

/* ---------- Live vitals (radar) ---------- */

function setBar(bar, text, value, max) {
  const v = Math.max(0, Math.min(max, Number(value) || 0));
  text.textContent = Math.round(v * 10) / 10;
  bar.style.width = Math.min(100, Math.round((v / max) * 100)) + '%';
  // Colour shifts as the value drops.
  const pct = v / max;
  if (pct > 0.5) bar.className = 'h-full rounded-full bg-gradient-to-r from-emerald-500 to-lime-400 transition-all duration-500';
  else if (pct > 0.25) bar.className = 'h-full rounded-full bg-gradient-to-r from-amber-500 to-yellow-400 transition-all duration-500';
  else bar.className = 'h-full rounded-full bg-gradient-to-r from-rose-600 to-red-500 transition-all duration-500';
}

function renderVitals(radar) {
  if (!radar || !radar.bot) return;
  els.vitalsGrid.classList.remove('hidden');
  els.vitalsPlaceholder.classList.add('hidden');

  const b = radar.bot;
  setBar(els.hpBar, els.hpText, b.health, 20);
  setBar(els.foodBar, els.foodText, b.food, 20);

  els.posX.textContent = Math.floor(b.x);
  els.posY.textContent = Math.floor(b.y);
  els.posZ.textContent = Math.floor(b.z);
  els.posYaw.textContent = Math.round(b.yaw || 0);

  // Minecraft yaw: 0 = south, 90 = west, 180 = north, -90 = east.
  const yaw = (((b.yaw || 0) % 360) + 360) % 360;
  const idx = Math.round(yaw / 45) % 8;
  els.facing.textContent = CARDINAL_SHORT[idx];
  els.facingDesc.textContent = CARDINAL[idx];

  // Nearby breakdown (players / mobs / everything else within the radius).
  const entities = radar.entities || [];
  const players = entities.filter((e) => e.type === 'player').length;
  const mobs = entities.filter((e) => e.type === 'mob').length;
  els.nbPlayers.textContent = players;
  els.nbMobs.textContent = mobs;
  els.nbTotal.textContent = radar.count || entities.length;
  els.nbRadius.textContent = radar.radius || 256;
}

/* ---------- Session totals ---------- */

function renderSessionStats(s) {
  if (!s) return;
  els.sessions.textContent = s.sessions || 0;
  els.connected.textContent = fmtDuration(s.connectedMs || 0);
  els.uptime.textContent = s.sessionUptimeMs ? fmtDuration(s.sessionUptimeMs) : '—';
  els.distance.textContent = fmtDistance(s.distanceWalked);
  els.mined.textContent = s.blocksMined || 0;
  els.dropped.textContent = s.itemsDropped || 0;
  els.attacks.textContent = s.attacks || 0;
  els.deaths.textContent = s.deaths || 0;

  if (s.lastConnectedAt) {
    els.lastConnected.textContent = 'Last connected ' + new Date(s.lastConnectedAt).toLocaleString();
    els.lastConnected.className = 'badge badge-emerald shrink-0';
  }
}

/* ---------- Activity feed ---------- */

const FEED_MAX = 150;

function addFeedEntry(entry) {
  if (!entry || typeof entry.message !== 'string') return;
  els.feed.classList.remove('hidden');
  els.feedEmpty.classList.add('hidden');

  const el = document.createElement('div');
  const level = entry.level === 'error' ? 'error' : entry.level === 'warn' ? 'warn' : 'info';
  const time = entry.time ? new Date(entry.time).toLocaleTimeString() : '';
  el.className =
    'flex items-start gap-2.5 rounded-lg bg-white/[0.02] border px-3 py-2 ' +
    (level === 'error'
      ? 'border-rose-500/25'
      : level === 'warn'
        ? 'border-amber-500/25'
        : 'border-white/5');
  el.innerHTML =
    `<span class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
      level === 'error' ? 'bg-rose-400' : level === 'warn' ? 'bg-amber-400' : 'bg-emerald-400'
    }"></span>` +
    `<p class="text-xs text-slate-300 leading-relaxed flex-1 min-w-0">${escapeHtml(entry.message)}</p>` +
    (time ? `<span class="text-[10px] text-slate-600 font-mono shrink-0">${time}</span>` : '');

  els.feed.insertBefore(el, els.feed.firstChild);
  while (els.feed.children.length > FEED_MAX) {
    els.feed.removeChild(els.feed.lastChild);
  }
}

/* ---------- Dashboard server ---------- */

function renderServerStats(s) {
  if (!s) return;
  els.svUptime.textContent = fmtDuration((s.uptimeSeconds || 0) * 1000);
  els.svNode.textContent = s.nodeVersion || '—';
  if (s.memory) {
    const used = s.memory.heapUsed;
    const total = s.memory.heapTotal || 1;
    els.svMem.textContent = `${fmtBytes(used)} / ${fmtBytes(total)}`;
    els.svMemFill.style.width = Math.min(100, Math.round((used / total) * 100)) + '%';
  }
}

/* ---------- Mobile sidebar / helpers ---------- */

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
document.querySelectorAll('[data-nav]').forEach((link) => link.addEventListener('click', closeSidebar));

function setConnPills(online) {
  const cls = online ? 'text-emerald-400' : 'text-slate-500';
  els.connPillSidebar.textContent = online ? '● Online' : '○ Offline';
  els.connPillSidebar.className = 'text-xs font-bold ' + cls;
  els.connPillMobile.textContent = online ? '●' : '○';
  els.connPillMobile.className = 'text-xs font-bold ' + cls;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
