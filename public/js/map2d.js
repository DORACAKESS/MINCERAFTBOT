'use strict';

/* ============================================================
   MineBot — 2D Map (radar) page logic
   Top-down canvas view centred on the bot. North is up.
   Colours match the 3D viewer: bot emerald, players blue,
   hostile mobs red, passive mobs green, other entities slate.
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
  placeholder: $('radar-placeholder'),
  panel: $('radar-panel'),
  count: $('radar-count'),
  botLine: $('radar-bot'),
  canvas: $('radar-canvas'),
  tip: $('radar-tip'),
  terrainStatus: $('terrain-status')
};

const STATE_META = {
  stopped:      { text: 'STOPPED',      pill: '' },
  connecting:   { text: 'CONNECTING',   pill: 'connecting' },
  connected:    { text: 'IN SERVER',    pill: 'connected' },
  disconnected: { text: 'DISCONNECTED', pill: 'disconnected' },
  error:        { text: 'ERROR',        pill: 'error' }
};

const COLORS = {
  bot: '#34d399',
  player: '#60a5fa',
  hostile: '#ef4444',
  passive: '#4ade80',
  other: '#94a3b8'
};

const HOSTILE_RE =
  /(zombie|zombie_villager|drowned|husk|skeleton|stray|wither_skeleton|creeper|spider|cave_spider|enderman|endermite|silverfish|witch|blaze|ghast|magma_cube|slime|phantom|shulker|guardian|elder_guardian|vex|pillager|vindicator|evoker|illusioner|ravager|piglin|piglin_brute|hoglin|zoglin|warden|wither|ender_dragon|giant|breeze|bogged)/;

let radar = null; // latest bot:radar snapshot
let range = 128; // display radius in blocks
let botConnected = false;
let terrainOn = true; // live terrain layer toggle

/* ---------- Live terrain tiles ----------
   The server streams per-chunk surface strings (1 char per block column,
   index into TERRAIN_PALETTE). Each chunk becomes a 16x16 canvas tile that
   we blit under the grid — crisp at any zoom, no per-frame block loop. */

const TERRAIN_PALETTE = {
  '1': '#2e6fe0', // water
  '2': '#ff5a1f', // lava
  '3': '#e8d89c', // sand
  '4': '#63c242', // grass
  '5': '#9a6a3a', // dirt
  '6': '#8a8a8a', // stone
  '7': '#b8b0a6', // gravel
  '8': '#e8f4ff', // snow / ice
  '9': '#3d9b35', // leaves
  A: '#7a5230', // wood
  B: '#8a3b3b', // nether
  C: '#6b6b6b' // other solid
};

const terrainTiles = new Map(); // 'x,z' -> 16x16 canvas

function decodeTerrainTile(str) {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d');
  for (let i = 0; i < 256; i++) {
    const color = TERRAIN_PALETTE[str[i]];
    if (!color) continue;
    g.fillStyle = color;
    g.fillRect(i & 15, i >> 4, 1, 1);
  }
  return c;
}

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
  botConnected = snap.state === 'connected';
  if (!botConnected) {
    radar = null;
    els.panel.classList.add('hidden');
    els.placeholder.classList.remove('hidden');
    els.count.textContent = '0 entities';
    els.botLine.textContent = '—';
  }
});

socket.on('bot:radar', (r) => {
  radar = r;
  if (!r) return;
  els.panel.classList.remove('hidden');
  els.placeholder.classList.add('hidden');
  els.count.textContent = `${r.count} entit${r.count === 1 ? 'y' : 'ies'}`;
  els.botLine.innerHTML =
    `${mbIco('robot')} ${r.bot.name} at x=${r.bot.x}, y=${r.bot.y}, z=${r.bot.z}` +
    (typeof r.bot.health === 'number' ? ` · ${mbIco('heart')} ${r.bot.health} · ${mbIco('meat')} ${r.bot.food}` : '');
  updateTerrainStatus();
  draw();
});

socket.on('bot:terrain', (t) => {
  if (!t) return;
  if (t.type === 'reset') {
    terrainTiles.clear();
  } else if (t.type === 'chunks' && Array.isArray(t.chunks)) {
    for (const c of t.chunks) {
      if (!c || typeof c.data !== 'string' || c.data.length !== 256) continue;
      terrainTiles.set(c.x + ',' + c.z, decodeTerrainTile(c.data));
    }
    // Keep the tile cache bounded: drop anything far outside the view.
    if (radar && terrainTiles.size > 900) {
      const bx = Math.floor(radar.bot.x / 16);
      const bz = Math.floor(radar.bot.z / 16);
      for (const [k, tile] of terrainTiles) {
        if (terrainTiles.size <= 700) break;
        const [x, z] = k.split(',').map(Number);
        if (Math.max(Math.abs(x - bx), Math.abs(z - bz)) > 24) terrainTiles.delete(k);
      }
    }
  }
  updateTerrainStatus();
  if (radar) draw();
});

/* ---------- Classification ---------- */

function classify(e) {
  if (e.username) return 'player';
  const n = String(e.name || '');
  if (e.type === 'player' || n === 'player') return 'player';
  if (e.type === 'mob') return HOSTILE_RE.test(n) ? 'hostile' : 'passive';
  return 'other';
}

/* ---------- Canvas rendering ---------- */

function setupCanvas() {
  const rect = els.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  els.canvas.width = Math.max(1, Math.round(rect.width * dpr));
  els.canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = els.canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height };
}

function draw() {
  if (!radar) return;
  const { ctx, w, h } = setupCanvas();
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h) / 2 / range; // pixels per block

  // Background
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, w, h);

  // Live terrain layer (chunk tiles) — under the grid so grid + labels stay readable.
  if (terrainOn && terrainTiles.size && radar) {
    const minCX = Math.floor((radar.bot.x - range) / 16);
    const maxCX = Math.floor((radar.bot.x + range) / 16);
    const minCZ = Math.floor((radar.bot.z - range) / 16);
    const maxCZ = Math.floor((radar.bot.z + range) / 16);
    ctx.imageSmoothingEnabled = false;
    for (let z = minCZ; z <= maxCZ; z++) {
      for (let x = minCX; x <= maxCX; x++) {
        const tile = terrainTiles.get(x + ',' + z);
        if (!tile) continue;
        const sx = cx + (x * 16 - radar.bot.x) * scale;
        const sy = cy + (z * 16 - radar.bot.z) * scale;
        if (sx + 16 * scale < 0 || sx > w || sy + 16 * scale < 0 || sy > h) continue;
        ctx.drawImage(tile, sx, sy, 16 * scale, 16 * scale);
      }
    }
  }

  // Adaptive grid step (nice numbers: 1/2/5 × 10^n)
  const step = niceStep(64 / scale);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.fillStyle = 'rgba(148,163,184,0.35)';
  ctx.font = '10px "JetBrains Mono", Consolas, monospace';
  ctx.lineWidth = 1;
  const startBx = Math.floor((0 - cx) / (scale * step)) * step;
  for (let b = startBx; b * scale + cx <= w; b += step) {
    const x = Math.round(cx + b * scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (b !== 0) ctx.fillText(String(b), x + 3, cy + 3);
  }
  const startBz = Math.floor((0 - cy) / (scale * step)) * step;
  for (let b = startBz; b * scale + cy <= h; b += step) {
    const y = Math.round(cy + b * scale) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    if (b !== 0) ctx.fillText(String(b), cx + 3, y + 3);
  }

  // Range rings
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  for (const r of [0.5, 1]) {
    ctx.beginPath();
    ctx.arc(cx, cy, range * scale * r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Compass (N up)
  ctx.fillStyle = '#ef4444';
  ctx.beginPath();
  ctx.moveTo(cx, 10);
  ctx.lineTo(cx - 6, 22);
  ctx.lineTo(cx + 6, 22);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#64748b';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', cx, 32);
  ctx.textAlign = 'left';

  // Entities (nearest drawn last = on top)
  const inRange = radar.entities.filter((e) => e.distance <= range);
  for (const e of inRange) {
    const sx = cx + (e.x - radar.bot.x) * scale;
    const sy = cy + (e.z - radar.bot.z) * scale;
    if (sx < -12 || sx > w + 12 || sy < -12 || sy > h + 12) continue;
    const kind = classify(e);
    const r = e.type === 'mob' || e.type === 'player' ? 5 : 3.5;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS[kind];
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Bot: heading arrow + emerald marker
  const bx = cx;
  const by = cy;
  const hx = -Math.sin(radar.bot.yaw); // mineflayer heading: (-sin yaw, -cos yaw)
  const hz = -Math.cos(radar.bot.yaw);
  const al = 20;
  ctx.save();
  ctx.translate(bx, by);
  // Arrow tip is drawn at local (0,-al) (up). After rotate(θ) the tip lands
  // on (sinθ, -cosθ); we want that to equal the heading (hx, hz), so
  // sinθ = hx and cosθ = -hz → θ = atan2(hx, -hz).
  ctx.rotate(Math.atan2(hx, -hz)); // screen: x right, z down
  ctx.beginPath();
  ctx.moveTo(0, -al);
  ctx.lineTo(-7, 6);
  ctx.lineTo(7, 6);
  ctx.closePath();
  ctx.fillStyle = COLORS.bot;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(bx, by, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#022c22';
  ctx.fill();
  ctx.strokeStyle = COLORS.bot;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Bot label
  ctx.fillStyle = '#34d399';
  ctx.font = '600 11px "JetBrains Mono", Consolas, monospace';
  ctx.fillText('YOU', bx + 9, by - 8);
}

function niceStep(raw) {
  if (raw < 1) raw = 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

/* ---------- Hover tooltip ---------- */

els.canvas.addEventListener('mousemove', (ev) => {
  if (!radar) return;
  const rect = els.canvas.getBoundingClientRect();
  const scale = Math.min(rect.width, rect.height) / 2 / range;
  // Find the closest entity dot within 10px.
  let best = null;
  let bestD = 10;
  for (const e of radar.entities) {
    if (e.distance > range) continue;
    const sx = rect.left + rect.width / 2 + (e.x - radar.bot.x) * scale;
    const sy = rect.top + rect.height / 2 + (e.z - radar.bot.z) * scale;
    const d = Math.hypot(ev.clientX - sx, ev.clientY - sy);
    if (d < bestD) {
      bestD = d;
      best = e;
    }
  }
  if (best) {
    const name = best.username || best.name || best.type;
    const kind = classify(best);
    const typeLabel = { player: 'Player', hostile: 'Hostile mob', passive: 'Passive mob', other: best.type }[kind];
    els.tip.innerHTML =
      `<div class="flex items-center gap-1.5 font-bold" style="color:${COLORS[kind]}">` +
      `<span class="w-2 h-2 rounded-full inline-block" style="background:${COLORS[kind]}"></span>${escapeHtml(name)}</div>` +
      `<div class="text-slate-400 mt-0.5">${escapeHtml(typeLabel)} · ${best.distance} m away</div>` +
      `<div class="text-slate-500 mt-0.5">x=${best.x} y=${best.y} z=${best.z}</div>`;
    els.tip.classList.remove('hidden');
    const tw = els.tip.offsetWidth || 160;
    const th = els.tip.offsetHeight || 60;
    let x = ev.clientX - rect.left + 14;
    let y = ev.clientY - rect.top + 14;
    if (x + tw > rect.width - 6) x = ev.clientX - rect.left - tw - 12;
    if (y + th > rect.height - 6) y = ev.clientY - rect.top - th - 12;
    els.tip.style.left = Math.max(6, x) + 'px';
    els.tip.style.top = Math.max(6, y) + 'px';
  } else {
    els.tip.classList.add('hidden');
  }
});

els.canvas.addEventListener('mouseleave', () => els.tip.classList.add('hidden'));

/* ---------- Terrain loading indicator ---------- */

function terrainProgress() {
  if (!radar) return null;
  const minCX = Math.floor((radar.bot.x - range) / 16);
  const maxCX = Math.floor((radar.bot.x + range) / 16);
  const minCZ = Math.floor((radar.bot.z - range) / 16);
  const maxCZ = Math.floor((radar.bot.z + range) / 16);
  let total = 0;
  let loaded = 0;
  for (let z = minCZ; z <= maxCZ; z++) {
    for (let x = minCX; x <= maxCX; x++) {
      total++;
      if (terrainTiles.has(x + ',' + z)) loaded++;
    }
  }
  return { total, loaded };
}

function updateTerrainStatus() {
  if (!els.terrainStatus) return;
  if (!terrainOn || !radar) {
    els.terrainStatus.classList.add('hidden');
    return;
  }
  const p = terrainProgress();
  if (!p || p.total === 0 || p.loaded >= p.total) {
    els.terrainStatus.classList.add('hidden');
    return;
  }
  els.terrainStatus.innerHTML = `${mbIco('pick')} terrain ${Math.round((p.loaded / p.total) * 100)}%`;
  els.terrainStatus.classList.remove('hidden');
}

/* ---------- Range control ---------- */

function setRange(r) {
  range = r;
  document.querySelectorAll('.range-btn').forEach((b) => {
    const on = Number(b.dataset.range) === r;
    b.classList.toggle('bg-emerald-500/15', on);
    b.classList.toggle('text-emerald-300', on);
    b.classList.toggle('text-slate-400', !on);
  });
  if (radar) draw();
}

document.querySelectorAll('.range-btn').forEach((b) =>
  b.addEventListener('click', () => setRange(Number(b.dataset.range)))
);
setRange(128);

/* ---------- Terrain toggle ---------- */

const terrainToggle = $('terrain-toggle');
if (terrainToggle) {
  terrainToggle.checked = terrainOn;
  terrainToggle.addEventListener('change', () => {
    terrainOn = terrainToggle.checked;
    updateTerrainStatus();
    if (radar) draw();
  });
}

window.addEventListener('resize', () => { if (radar) draw(); });

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
    .replace(/"/g, '&quot;');
}
