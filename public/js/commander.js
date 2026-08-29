'use strict';

/* ============================================================
   MineBot — Command Commander page logic
   Manage authorized in-game commanders (name + power level) and
   browse the quick-command reference. Admin edits; guests can
   view the command list but not change who can command.
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
  stateBadge: $('commander-state-badge'),
  enabled: $('cmd-enabled'),
  name: $('cmd-name'),
  level: $('cmd-level'),
  addBtn: $('cmd-add'),
  list: $('cmd-list'),
  listEmpty: $('cmd-list-empty'),
  count: $('cmd-count'),
  saveBtn: $('cmd-save'),
  tree: $('cmd-tree'),
  toasts: $('toasts')
};

let isAdmin = false;
let config = { enabled: true, prefix: '.', players: [] };
let players = []; // working copy of config.players
let levelNames = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Owner' };

/* ---------- Auth ---------- */

fetch('/api/auth/me')
  .then((r) => r.json())
  .then((d) => {
    if (!d.ok) {
      window.location.replace('/login.html');
      return;
    }
    isAdmin = d.user.role === 'admin';
    els.userBadge.innerHTML = mbIco('user') + ` ${d.user.username} · ${d.user.role === 'admin' ? 'Admin' : 'Guest'}`;
    setEditDisabled(!isAdmin);
    if (!isAdmin) {
      toast('Guests can view commands but only admins can manage commanders.', 'info');
    }
  })
  .catch(() => window.location.replace('/login.html'));

els.logoutBtn.addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.replace('/login.html');
});

/* ---------- Socket.io ---------- */

const socket = io();

socket.on('connect', () => {
  setConnPills(true);
  socket.emit('commander:get', (r) => {
    if (r && r.ok) applyConfig(r.config, r.levelNames);
  });
  socket.emit('commander:commands', (r) => {
    if (r && r.ok) renderTree(r.categories, r.levelNames);
  });
});
socket.on('disconnect', () => setConnPills(false));

socket.on('commander:config', (r) => {
  if (r && r.ok) applyConfig(r.config, r.levelNames);
});
socket.on('commander:updated', (r) => {
  if (r && r.config) applyConfig(r.config, r.levelNames);
  toast('Commander settings saved.', 'success');
});

/* ---------- Config rendering ---------- */

function applyConfig(cfg, lv) {
  if (!cfg) return;
  config = cfg;
  if (lv) levelNames = lv;
  els.enabled.checked = !!cfg.enabled;
  players = (cfg.players || []).map((p) => ({ name: p.name, level: p.level }));
  renderPlayers();
  updateStateBadge();
}

function updateStateBadge() {
  els.stateBadge.textContent = config.enabled
    ? '● Commands ON' + (players.length ? '' : ' · no players')
    : '○ Disabled';
  els.stateBadge.className = 'badge shrink-0 ' + (config.enabled ? 'badge-emerald' : 'badge-slate');
}

function levelClass(level) {
  return level === 4 ? 'badge-owner' : level === 3 ? 'badge-high' : level === 2 ? 'badge-medium' : 'badge-low';
}

function levelBadge(level) {
  return `<span class="badge ${levelClass(level)} shrink-0">L${level} ${levelNames[level] || ''}</span>`;
}

function renderPlayers() {
  els.list.innerHTML = '';
  els.count.textContent = players.length + (players.length === 1 ? ' player' : ' players');
  els.listEmpty.classList.toggle('hidden', players.length > 0);
  players.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'animate-fade-up flex items-center gap-3 rounded-xl bg-white/[0.03] border border-white/5 px-3.5 py-2.5';
    row.innerHTML = `
      <span class="w-8 h-8 rounded-lg grid place-items-center bg-slate-800/80 text-base select-none">${mbIco('user')}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-bold text-slate-100 truncate">${escapeHtml(p.name)}</p>
        <p class="text-[10px] text-slate-500 uppercase tracking-wider">${levelNames[p.level] || ''}</p>
      </div>
      ${levelBadge(p.level)}
      <button class="cmd-remove btn btn-ghost text-xs px-2.5 py-1.5" data-idx="${idx}" title="Remove ${escapeHtml(p.name)}">${mbIco('x')}</button>
    `;
    row.querySelector('.cmd-remove').addEventListener('click', () => {
      players.splice(idx, 1);
      renderPlayers();
    });
    els.list.appendChild(row);
  });
}

/* ---------- Add player ---------- */

function addPlayer() {
  const name = els.name.value.trim();
  const level = Number(els.level.value);
  if (!name) return toast('Type a player name first.', 'error');
  if (players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return toast(`"${name}" is already listed — each name gets one power level.`, 'error');
  }
  players.push({ name, level });
  els.name.value = '';
  els.name.focus();
  renderPlayers();
}

els.addBtn.addEventListener('click', addPlayer);
els.name.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addPlayer();
  }
});

/* ---------- Save ---------- */

els.saveBtn.addEventListener('click', () => {
  socket.emit('commander:save', { enabled: els.enabled.checked, players }, (res) => {
    if (res && res.ok) {
      applyConfig(res.config);
      toast('Commander settings saved.', 'success');
    } else {
      const errs = (res && res.errors) || ['Could not save.'];
      errs.forEach((e) => toast(e, 'error'));
    }
  });
});

/* ---------- Quick command tree ---------- */

function renderTree(categories, lv) {
  if (lv) levelNames = lv;
  if (!Array.isArray(categories) || !categories.length) {
    els.tree.innerHTML = '<p class="text-sm text-slate-500">No commands available.</p>';
    return;
  }
  els.tree.innerHTML = '';
  for (const cat of categories) {
    const block = document.createElement('div');
    block.className = 'rounded-xl bg-white/[0.03] border border-white/5 overflow-hidden';

    // Category header
    const head = document.createElement('div');
    head.className = 'flex flex-wrap items-center gap-2 px-4 py-3 bg-white/[0.02] border-b border-white/5';
    head.innerHTML = `
      <span class="font-mono text-sm font-extrabold text-emerald-300">.${escapeHtml(cat.id)}</span>
      ${levelBadge(cat.level)}
      <span class="text-xs text-slate-500 ml-auto text-right">${escapeHtml(cat.description)}</span>
    `;
    block.appendChild(head);

    const body = document.createElement('div');
    body.className = 'divide-y divide-white/[0.04]';

    const rows = [];
    // Bare category command (when the category itself is runnable, e.g. .inv)
    rows.push({
      syntax: `.${cat.id}`,
      level: cat.level,
      desc: `Run .${cat.id} (${cat.description.split('—')[0].trim()})`
    });
    // Sub-commands
    for (const sub of cat.subcommands || []) {
      const arg = sub.arg ? ` <${sub.arg}>` : '';
      rows.push({ syntax: `.${cat.id}:${sub.id}${arg}`, level: sub.level, desc: sub.description });
    }
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'flex flex-wrap items-center gap-2.5 px-4 py-2.5 hover:bg-white/[0.02] transition-colors';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'cmd-copy btn btn-ghost text-[11px] px-2 py-1 shrink-0';
      copy.textContent = '⧉ copy';
      copy.addEventListener('click', () => copyText(row.syntax));
      // Escape exactly once, at render time.
      line.innerHTML = `
        <code class="font-mono text-[13px] text-slate-200">${escapeHtml(row.syntax)}</code>
        ${levelBadge(row.level)}
        <span class="text-[11px] text-slate-500 min-w-0 flex-1">${escapeHtml(row.desc)}</span>
      `;
      line.appendChild(copy);
      body.appendChild(line);
    }

    block.appendChild(body);
    els.tree.appendChild(block);
  }
}

function copyText(text) {
  const done = () => toast(`Copied: ${text}`, 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (_) {
    toast('Could not copy — select the text manually.', 'error');
  }
  ta.remove();
}

/* ---------- Guest mode ---------- */

function setEditDisabled(disabled) {
  for (const el of [els.enabled, els.name, els.level, els.addBtn, els.saveBtn]) {
    if (el) el.disabled = disabled;
  }
  // Existing remove buttons (re-rendered on config) are handled in renderPlayers.
  els.list.querySelectorAll('.cmd-remove').forEach((b) => (b.disabled = disabled));
  els.name.placeholder = disabled ? 'Guests cannot manage players' : 'Minecraft name (case-insensitive)';
}

/* ---------- Toasts ---------- */

function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind === 'success' ? 'success' : kind === 'error' ? 'error' : '');
  el.innerHTML =
    `<span>${kind === 'success' ? mbIco('circle-check') : kind === 'error' ? mbIco('alert-triangle') : mbIco('message-circle')}</span>` +
    `<span class="flex-1">${escapeHtml(msg)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3800);
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
document.querySelectorAll('[data-nav]').forEach((l) => l.addEventListener('click', closeSidebar));

/* ---------- Helpers ---------- */

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
