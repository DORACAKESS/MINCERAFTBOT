'use strict';

/* ============================================================
   MineBot — Console page logic
   Sends chat messages / server commands as the bot and shows the
   live log in real time (batch on connect + live single lines),
   with level colour separation, icons, chat-in/out distinction,
   filters, search, pause and copy.
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
  cmdInput: $('cmd-input'),
  sendBtn: $('send-btn'),
  quickChips: $('quick-chips'),
  logConsole: $('log-console'),
  logEmpty: $('log-empty'),
  logCount: $('log-count'),
  logPause: $('log-pause'),
  logCopy: $('log-copy'),
  clearLogs: $('clear-logs'),
  logSearch: $('log-search'),
  logFilters: $('log-filters'),
  toasts: $('toasts')
};

const STATE_META = {
  stopped:      { text: 'STOPPED',      pill: '' },
  connecting:   { text: 'CONNECTING',   pill: 'connecting' },
  connected:    { text: 'IN SERVER',    pill: 'connected' },
  disconnected: { text: 'DISCONNECTED', pill: 'disconnected' },
  error:        { text: 'ERROR',        pill: 'error' }
};

/* ---------- Quick access commands (grouped) ----------
   Commands without a placeholder send instantly when clicked.
   Commands containing "<...>" fill the input instead so the user
   can complete the parameter before pressing Enter. */
const QUICK_GROUPS = [
  {
    label: mbIco('message-circle') + ' Chat',
    items: [
      { label: '/help', cmd: '/help' },
      { label: '/list', cmd: '/list' },
      { label: '/ping', cmd: '/ping' },
      { label: '/rules', cmd: '/rules' },
      { label: mbIco('hand-grab') + ' Hello everyone!', cmd: 'Hello everyone!' },
      { label: mbIco('map-pin') + ' Where are we?', cmd: 'Where are we?' },
      { label: 'GG!', cmd: 'GG!' },
      { label: 'Thanks!', cmd: 'Thanks!' }
    ]
  },
  {
    label: mbIco('globe') + ' Teleport',
    items: [
      { label: '/spawn', cmd: '/spawn' },
      { label: '/tpa <player>', cmd: '/tpa ' },
      { label: '/tpahere <player>', cmd: '/tpahere ' },
      { label: '/tpaccept', cmd: '/tpaccept' },
      { label: '/tpdeny', cmd: '/tpdeny' },
      { label: '/back', cmd: '/back' }
    ]
  },
  {
    label: mbIco('home') + ' Homes & Warps',
    items: [
      { label: '/home', cmd: '/home' },
      { label: '/sethome', cmd: '/sethome' },
      { label: '/delhome', cmd: '/delhome' },
      { label: '/warp <name>', cmd: '/warp ' },
      { label: '/kit <name>', cmd: '/kit ' },
      { label: '/near', cmd: '/near' }
    ]
  },
  {
    label: mbIco('coin') + ' Economy',
    items: [
      { label: '/balance', cmd: '/balance' },
      { label: '/baltop', cmd: '/baltop' },
      { label: '/pay <player> <amount>', cmd: '/pay ' },
      { label: '/echest', cmd: '/echest' },
      { label: '/ah', cmd: '/ah' },
      { label: '/shop', cmd: '/shop' }
    ]
  },
  {
    label: mbIco('device-gamepad') + ' Extra',
    items: [
      { label: '/afk', cmd: '/afk' },
      { label: '/fly', cmd: '/fly' },
      { label: '/speed <num>', cmd: '/speed ' },
      { label: '/god', cmd: '/god' },
      { label: '/heal', cmd: '/heal' },
      { label: '/hat', cmd: '/hat' },
      { label: '/trash', cmd: '/trash' }
    ]
  },
  {
    label: mbIco('tools') + ' Admin (OP)',
    items: [
      { label: '/gamemode creative', cmd: '/gamemode creative' },
      { label: '/gamemode survival', cmd: '/gamemode survival' },
      { label: '/tp <player>', cmd: '/tp ' },
      { label: '/give <player> <item> <count>', cmd: '/give ' },
      { label: '/time set day', cmd: '/time set day' },
      { label: '/time set night', cmd: '/time set night' },
      { label: '/weather clear', cmd: '/weather clear' },
      { label: '/clear <player>', cmd: '/clear ' },
      { label: '/kick <player>', cmd: '/kick ' },
      { label: '/effect <player> speed 1 30', cmd: '/effect ' }
    ]
  }
];

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

socket.on('bot:logs', (logs) => {
  clearLogs();
  logs.forEach(appendLog);
});

// Live single lines — the whole point of a console.
socket.on('bot:log', (entry) => appendLog(entry));

/* ---------- Sending ---------- */

function send(text) {
  const message = String(text || '').trim();
  if (!message) return;
  socket.emit('bot:chat', { message }, (res) => {
    if (res && res.ok) {
      toast(`Sent: ${message}`, 'success');
    } else {
      toast(((res && res.errors) || ['Could not send.'])[0], 'error');
    }
  });
}

els.sendBtn.addEventListener('click', () => {
  send(els.cmdInput.value);
  els.cmdInput.value = '';
});

// Command history (per session).
const history = [];
let historyIdx = -1;

els.cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const v = els.cmdInput.value.trim();
    if (v) {
      history.unshift(v);
      if (history.length > 50) history.pop();
      send(v);
    }
    els.cmdInput.value = '';
    historyIdx = -1;
  } else if (e.key === 'ArrowUp') {
    if (!history.length) return;
    e.preventDefault();
    historyIdx = Math.min(historyIdx + 1, history.length - 1);
    els.cmdInput.value = history[historyIdx];
  } else if (e.key === 'ArrowDown') {
    if (historyIdx < 0) return;
    e.preventDefault();
    historyIdx -= 1;
    els.cmdInput.value = historyIdx >= 0 ? history[historyIdx] : '';
  }
});

/* ---------- Quick chips (grouped) ---------- */

function buildChips() {
  for (const group of QUICK_GROUPS) {
    const wrap = document.createElement('div');
    wrap.className = 'quick-group';
    const label = document.createElement('p');
    label.className = 'text-[10px] uppercase tracking-widest text-slate-500 mb-2';
    label.innerHTML = group.label;
    wrap.appendChild(label);
    const row = document.createElement('div');
    row.className = 'flex flex-wrap gap-2';
    for (const q of group.items) {
      const chip = document.createElement('button');
      chip.className =
        'px-3 py-1.5 rounded-full text-xs font-semibold border border-white/10 bg-white/[0.03] ' +
        'text-slate-300 transition-all hover:border-emerald-400/40 hover:bg-emerald-500/10 hover:text-emerald-200 ' +
        'hover:-translate-y-0.5 active:translate-y-0 active:scale-95 animate-fade-up';
      chip.innerHTML = q.label;
      chip.addEventListener('click', () => {
        if (/<[a-z]+>/.test(q.cmd)) {
          // Needs a parameter — fill the input and focus it.
          els.cmdInput.value = q.cmd;
          els.cmdInput.focus();
          const end = els.cmdInput.value.length;
          els.cmdInput.setSelectionRange(end, end);
          toast('Complete the command, then press Enter');
        } else {
          send(q.cmd);
        }
      });
      row.appendChild(chip);
    }
    wrap.appendChild(row);
    els.quickChips.appendChild(wrap);
  }
}
buildChips();

/* ---------- Logs ---------- */

const LEVEL_ICON = { info: mbIco('info-circle'), success: mbIco('circle-check'), warn: mbIco('alert-triangle'), error: mbIco('circle-x'), chat: mbIco('message-circle') };

let autoScroll = true;
let logFilter = 'all'; // all | chat | success | warn | error
let logQuery = '';

// In-game chat: the bot's own sends are logged as "[Bot] <text>", everything
// else as "<username> <text>" — colour them differently for at-a-glance flow.
function chatDirection(msg) {
  return String(msg || '').startsWith('[Bot]') ? 'out' : 'in';
}

function appendLog(entry) {
  if (!entry) return;
  els.logEmpty.classList.add('hidden');
  const level = entry.level || 'info';
  const msg = String(entry.message || '');
  const dir = level === 'chat' ? chatDirection(msg) : null;
  const time = new Date(entry.time || Date.now()).toLocaleTimeString();

  const div = document.createElement('div');
  div.className =
    'log-line log-' + level +
    (dir === 'out' ? ' log-chat-out' : dir === 'in' ? ' log-chat-in' : '');
  div.setAttribute('data-level', level);
  div.setAttribute('data-search', (time + ' ' + msg).toLowerCase());
  div.innerHTML =
    `<span class="log-ico">${LEVEL_ICON[level] || mbIco('info-circle')}</span>` +
    `<span class="log-time">${time}</span>` +
    `<span class="log-level">${level === 'chat' && dir === 'out' ? 'BOT' : level.toUpperCase()}</span>` +
    `<span class="msg">${escapeHtml(msg)}</span>`;
  els.logConsole.appendChild(div);

  applyFilterTo(div);

  const nearBottom =
    els.logConsole.scrollHeight - els.logConsole.scrollTop - els.logConsole.clientHeight < 80;
  if (autoScroll && nearBottom) els.logConsole.scrollTop = els.logConsole.scrollHeight;

  // Trim oldest lines, then refresh the counter so it never goes stale.
  while (els.logConsole.children.length > 300) {
    els.logConsole.removeChild(els.logConsole.firstChild);
  }
  updateCount();
}

function clearLogs() {
  els.logConsole.querySelectorAll('.log-line').forEach((n) => n.remove());
  els.logEmpty.classList.remove('hidden');
  updateCount();
}

els.clearLogs.addEventListener('click', clearLogs);

/* ---------- Filter / search / pause / copy ---------- */

function applyFilterTo(div) {
  const levelOk = logFilter === 'all' || div.getAttribute('data-level') === logFilter;
  const textOk = !logQuery || (div.getAttribute('data-search') || '').includes(logQuery);
  div.classList.toggle('log-hidden', !(levelOk && textOk));
}

function reapplyFilters() {
  els.logConsole.querySelectorAll('.log-line').forEach(applyFilterTo);
  updateCount();
}

els.logFilters.addEventListener('click', (e) => {
  const chip = e.target.closest('.log-filter-chip');
  if (!chip) return;
  logFilter = chip.dataset.filter || 'all';
  els.logFilters.querySelectorAll('.log-filter-chip').forEach((c) => {
    c.classList.toggle('active', c === chip);
  });
  reapplyFilters();
});

els.logSearch.addEventListener('input', () => {
  logQuery = els.logSearch.value.trim().toLowerCase();
  reapplyFilters();
});

els.logPause.addEventListener('click', () => {
  autoScroll = !autoScroll;    els.logPause.innerHTML = autoScroll ? mbIco('player-pause') + ' Pause' : mbIco('player-play') + ' Resume';
  els.logPause.title = autoScroll ? 'Pause or resume auto-scroll' : 'Resume auto-scroll (jumps to the newest line)';
  if (autoScroll) els.logConsole.scrollTop = els.logConsole.scrollHeight;
});

els.logCopy.addEventListener('click', async () => {
  const lines = [...els.logConsole.querySelectorAll('.log-line')]
    .filter((n) => !n.classList.contains('log-hidden'))
    .map((n) => {
      const t = n.querySelector('.log-time');
      const m = n.querySelector('.msg');
      return `${t ? t.textContent : ''} ${m ? m.textContent : ''}`;
    })
    .join('\n');
  if (!lines) return toast('Nothing to copy yet.', 'info');
  try {
    await navigator.clipboard.writeText(lines);
    toast('Log copied to the clipboard.', 'success');
  } catch (err) {
    toast('Clipboard blocked — select the text manually.', 'error');
  }
});

function updateCount() {
  if (!els.logCount) return;
  const visible = els.logConsole.querySelectorAll('.log-line:not(.log-hidden)').length;
  const total = els.logConsole.querySelectorAll('.log-line').length;
  els.logCount.textContent =
    total === visible ? `${total} line${total === 1 ? '' : 's'}` : `${visible}/${total} lines`;
}

/* ---------- Toasts ---------- */

function toast(message, type = 'info') {
  const icon = type === 'success' ? mbIco('circle-check') : type === 'error' ? mbIco('alert-triangle') : mbIco('message-circle');
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'success' ? 'success' : type === 'error' ? 'error' : '');
  el.innerHTML = `<span>${icon}</span><span class="flex-1">${escapeHtml(message)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3400);
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
document.querySelectorAll('[data-nav]').forEach((link) => link.addEventListener('click', closeSidebar));

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
    .replace(/"/g, '&quot;');
}
