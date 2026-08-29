'use strict';

/* ============================================================
   MineBot Dashboard — shared sticky top status bar
   ------------------------------------------------------------
   Injected as the first child of <main> on every dashboard page.
   Shows, live: bot connection state, bot name, server, Minecraft
   version and ping to the server, plus a dashboard-online dot,
   a global page search (press '/' to jump) and an accent-theme
   picker (saved per browser in localStorage).

   Pure vanilla JS + custom CSS (.mb-topbar* in style.css) so it
   never depends on the compiled Tailwind build.
   ============================================================ */

/* ============================================================
   Sidebar collapse rail (shared across all dashboard pages)
   ------------------------------------------------------------
   Toggles body.sb-collapsed (desktop-only rail via style.css),
   persists the choice per browser, and adds nav tooltips for the
   icon-only state. Runs before the top bar so the rail is set on
   first paint.
   ============================================================ */
(function () {
  const btn = document.getElementById('sb-collapse-btn');
  if (!btn) return; // page without a sidebar (login/404)
  const KEY = 'mb-sb';
  let collapsed = false;
  try { collapsed = localStorage.getItem(KEY) === '1'; } catch (_) { /* ignore */ }

  // Tooltips for the icon-only rail (handy on the full nav too) — the
  // leading emoji is stripped so the tooltip reads "Dashboard", not "🏠 Dashboard".
  document.querySelectorAll('#sidebar .nav-item').forEach((a) => {
    a.title = (a.textContent || '').replace(/\s+/g, ' ').trim().replace(/^\W+\s+/, '');
  });

  function apply(c) {
    document.body.classList.toggle('sb-collapsed', c);
    btn.setAttribute('aria-expanded', String(!c));
    btn.title = c ? 'Expand sidebar' : 'Collapse sidebar';
    try { localStorage.setItem(KEY, c ? '1' : '0'); } catch (_) { /* ignore */ }
  }

  btn.addEventListener('click', () => {
    apply(!document.body.classList.contains('sb-collapsed'));
  });

  apply(collapsed);
})();

(function () {
  if (typeof io === 'undefined') return; // socket.io not loaded (e.g. 404 page)
  const main = document.querySelector('main');
  if (!main) return;

  /* ---- Accent theme (apply before painting anything) ---- */
  const ACCENT_KEY = 'mb-accent';
  let savedAccent = 'emerald';
  try {
    savedAccent = localStorage.getItem(ACCENT_KEY) || 'emerald';
  } catch (_) { /* localStorage unavailable — keep default */ }
  document.documentElement.setAttribute('data-accent', savedAccent);

  /* ---- Global search index (pages + keywords) ---- */
  const PAGE_INDEX = [
    { icon: 'home', title: 'Dashboard', url: '/', keywords: 'home main bot setup start stop reconnect server config' },
    { icon: 'map-2', title: '3D Map', url: '/map.html', keywords: 'world view viewer wasd camera 3d chunks entities markers' },
    { icon: 'compass', title: '2D Map', url: '/map2d.html', keywords: 'radar terrain top down grid compass terrain layer' },
    { icon: 'backpack', title: 'Inventory', url: '/inventory.html', keywords: 'items backpack armor offhand hotbar drop eat auto tool shulker' },
    { icon: 'brain', title: 'AI Control', url: '/ai.html', keywords: 'chat bot ai agent build mode tools follow guard mine' },
    { icon: 'bolt', title: 'Commander', url: '/commander.html', keywords: 'players power levels help commands in game chat' },
    { icon: 'terminal-2', title: 'Console', url: '/console.html', keywords: 'commands logs chat terminal quick access' },
    { icon: 'chart-bar', title: 'Statistics', url: '/stats.html', keywords: 'uptime memory counters sessions distance stats' },
    { icon: 'building-skyscraper', title: 'Building', url: '/building.html', keywords: 'schematic litematic preview build materials chest operator' },
    { icon: 'device-gamepad', title: 'Controls', url: '/controls.html', keywords: 'follow guard mining sleep look at players behaviours' },
    { icon: 'settings', title: 'Settings', url: '/settings.html', keywords: 'accounts passwords passkeys ai keys prompt theme logout' }
  ];

  // ---- Build the bar -------------------------------------------------
  const bar = document.createElement('div');
  bar.id = 'mb-topbar';
  bar.className = 'mb-topbar';
  bar.innerHTML =
    '<div class="mb-tb-status stopped" id="mb-tb-status" title="Bot connection state">' +
    '  <span class="mb-tb-dot" id="mb-tb-dot"></span>' +
    '  <span id="mb-tb-state">STOPPED</span>' +
    '</div>' +
    '<div class="mb-tb-sep"></div>' +
    '<div class="mb-tb-chip" title="Bot name">' +
    '  <span class="mb-tb-ico">' + mbIco('user') + '</span><span class="mb-tb-value" id="mb-tb-name">—</span>' +
    '</div>' +
    '<div class="mb-tb-chip" title="Server">' +
    '  <span class="mb-tb-ico">' + mbIco('globe') + '</span><span class="mb-tb-value" id="mb-tb-server">—</span>' +
    '</div>' +
    '<div class="mb-tb-chip" title="Minecraft version">' +
    '  <span class="mb-tb-ico">' + mbIco('cube') + '</span><span class="mb-tb-value" id="mb-tb-version">—</span>' +
    '</div>' +
    '<div class="mb-tb-chip mb-tb-lat" id="mb-tb-lat-chip" title="Live ping to the Minecraft server">' +
    '  <span class="mb-tb-ico">' + mbIco('bolt') + '</span><span class="mb-tb-value" id="mb-tb-lat">—</span>' +
    '</div>' +
    '<div class="mb-tb-search-wrap" title="Search pages — press / to focus">' +
    '  <span class="mb-tb-ico">' + mbIco('search') + '</span>' +
    '  <input id="mb-tb-search" class="mb-tb-search" placeholder="Search… ( / )" autocomplete="off" spellcheck="false" aria-label="Search pages" />' +
    '  <div id="mb-tb-search-results" class="mb-tb-search-results hidden"></div>' +
    '</div>' +
    '<div class="mb-tb-theme-wrap">' +
    '  <button id="mb-tb-theme-btn" class="mb-tb-theme-btn" title="Accent theme" aria-label="Accent theme">' + mbIco('palette') + '</button>' +
    '  <div id="mb-tb-theme-pop" class="mb-tb-theme-pop hidden">' +
    '    <button class="mb-swatch sw-emerald" data-accent="emerald" title="Emerald" aria-label="Emerald theme"></button>' +
    '    <button class="mb-swatch sw-blue" data-accent="blue" title="Blue" aria-label="Blue theme"></button>' +
    '    <button class="mb-swatch sw-purple" data-accent="purple" title="Purple" aria-label="Purple theme"></button>' +
    '    <button class="mb-swatch sw-red" data-accent="red" title="Red" aria-label="Red theme"></button>' +
    '    <button class="mb-swatch sw-amber" data-accent="amber" title="Amber" aria-label="Amber theme"></button>' +
    '  </div>' +
    '</div>' +
    '<div class="mb-tb-chip mb-tb-dash" id="mb-tb-dash-chip" title="Dashboard server connection">' +
    '  <span class="mb-tb-dot mb-tb-dot-dash off" id="mb-tb-dash-dot"></span>' +
    '  <span id="mb-tb-dash">connecting…</span>' +
    '</div>';

  main.insertBefore(bar, main.firstChild);

  // NOTE: every call site passes the id WITH its '#' prefix, so the
  // helper must pass it through unchanged — prepending '#' here produced
  // '##mb-tb-…' which is an invalid selector and threw a SyntaxError on the
  // very first lookup, killing the whole bar (search/theme/socket/status).
  const $ = (id) => bar.querySelector(id);
  const statusEl = $('#mb-tb-status');
  const stateEl = $('#mb-tb-state');
  const nameEl = $('#mb-tb-name');
  const serverEl = $('#mb-tb-server');
  const versionEl = $('#mb-tb-version');
  const latEl = $('#mb-tb-lat');
  const latChip = $('#mb-tb-lat-chip');
  const dashEl = $('#mb-tb-dash');
  const dashDot = $('#mb-tb-dash-dot');

  // ---- State helpers -------------------------------------------------
  const STATE_META = {
    stopped:      { text: 'STOPPED',      cls: 'stopped' },
    connecting:   { text: 'CONNECTING',   cls: 'connecting' },
    connected:    { text: 'IN SERVER',    cls: 'connected' },
    disconnected: { text: 'DISCONNECTED', cls: 'disconnected' },
    error:        { text: 'ERROR',        cls: 'error' }
  };

  let latencyMs = null;
  let lastBotState = 'stopped'; // last known bot state (kept across dashboard reconnects)

  function renderState(state) {
    lastBotState = STATE_META[state] ? state : 'stopped';
    const meta = STATE_META[state] || STATE_META.stopped;
    statusEl.className = 'mb-tb-status ' + meta.cls;
    stateEl.textContent = meta.text;
  }

  function renderConfig(cfg) {
    if (!cfg) return;
    nameEl.textContent = String(cfg.botName || '').trim() || '—';
    const ip = String(cfg.serverIp || '').trim();
    const port = cfg.serverPort ? ':' + cfg.serverPort : '';
    serverEl.textContent = ip ? ip + port : '—';
    versionEl.textContent = String(cfg.version || '').trim() || '—';
  }

  function renderLatency(ms) {
    latencyMs = (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) ? Math.round(ms) : null;
    if (latencyMs === null) {
      latEl.textContent = '—';
      latChip.classList.remove('good', 'ok', 'bad');
      return;
    }
    latEl.textContent = latencyMs + 'ms';
    latChip.classList.remove('good', 'ok', 'bad');
    if (latencyMs < 80) latChip.classList.add('good');
    else if (latencyMs < 150) latChip.classList.add('ok');
    else latChip.classList.add('bad');
  }

  function renderDash(on) {
    dashDot.className = 'mb-tb-dot mb-tb-dot-dash ' + (on ? 'on' : 'off');
    dashEl.textContent = on ? 'v1.0 · online' : 'v1.0 · offline';
  }

  // ---- Global search (command palette) -------------------------------
  const searchInput = $('#mb-tb-search');
  const searchResults = $('#mb-tb-search-results');
  let activeIdx = -1;
  let matches = [];

  function closeSearch() {
    searchResults.classList.add('hidden');
    activeIdx = -1;
    matches = [];
  }

  function navigate(entry) {
    closeSearch();
    searchInput.blur();
    window.location.href = entry.url;
  }

  function renderSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) {
      searchResults.classList.add('hidden');
      matches = [];
      activeIdx = -1;
      return;
    }
    matches = PAGE_INDEX.filter((p) =>
      p.title.toLowerCase().includes(q) ||
      p.keywords.includes(q) ||
      p.url.includes(q)
    ).slice(0, 8);
    activeIdx = matches.length ? 0 : -1;

    if (!matches.length) {
      searchResults.innerHTML = '<div class="mb-sr-empty">No pages match “' + searchInput.value.trim() + '”</div>' +
        '<div class="mb-tb-search-hint">Tip: try “map”, “inventory”, “ai”, “settings”…</div>';
    } else {
      searchResults.innerHTML =
        matches
          .map(
            (m, i) =>
              '<button class="mb-sr' + (i === activeIdx ? ' active' : '') + '" data-i="' + i + '">' +
              '<span class="mb-sr-ico">' + mbIco(m.icon) + '</span>' +
              '<span>' + m.title + '</span>' +
              '<span class="mb-sr-url">' + m.url + '</span>' +
              '</button>'
          )
          .join('') +
        '<div class="mb-tb-search-hint">↑↓ to move · Enter to open · Esc to close</div>';
    }
    searchResults.classList.remove('hidden');
  }

  searchInput.addEventListener('input', renderSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (matches.length) activeIdx = (activeIdx + 1) % matches.length;
      renderSearch();
      const rows = searchResults.querySelectorAll('.mb-sr');
      if (rows[activeIdx]) rows[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length) activeIdx = (activeIdx - 1 + matches.length) % matches.length;
      renderSearch();
      const rows = searchResults.querySelectorAll('.mb-sr');
      if (rows[activeIdx]) rows[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (matches[activeIdx]) navigate(matches[activeIdx]);
    } else if (e.key === 'Escape') {
      closeSearch();
      searchInput.blur();
    }
  });

  searchResults.addEventListener('click', (e) => {
    const row = e.target.closest('.mb-sr');
    if (row) navigate(matches[Number(row.dataset.i)]);
  });

  // Pressing '/' anywhere focuses the search (unless already typing).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement && document.activeElement.isContentEditable) return;
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  });

  // ---- Accent theme picker -------------------------------------------
  const themeBtn = $('#mb-tb-theme-btn');
  const themePop = $('#mb-tb-theme-pop');

  function setAccent(name) {
    document.documentElement.setAttribute('data-accent', name);
    try { localStorage.setItem(ACCENT_KEY, name); } catch (_) { /* ignore */ }
    themePop.querySelectorAll('.mb-swatch').forEach((s) => {
      s.classList.toggle('active', s.dataset.accent === name);
    });
  }

  themeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    themePop.classList.toggle('hidden');
  });

  themePop.addEventListener('click', (e) => {
    const sw = e.target.closest('.mb-swatch');
    if (sw) {
      setAccent(sw.dataset.accent);
      themePop.classList.add('hidden');
    }
  });

  document.addEventListener('click', (e) => {
    if (!themePop.classList.contains('hidden') && !e.target.closest('.mb-tb-theme-wrap')) {
      themePop.classList.add('hidden');
    }
    if (!searchResults.classList.contains('hidden') && !e.target.closest('.mb-tb-search-wrap')) {
      closeSearch();
    }
  });

  setAccent(savedAccent);

  // ---- Socket wiring -------------------------------------------------
  const socket = io();

  socket.on('connect', () => {
    renderDash(true);
    // If a dashboard reconnect missed a push, restore the last known bot state
    // (bot:state re-fires right after anyway and corrects it).
    renderState(lastBotState);
  });
  socket.on('disconnect', () => {
    // Only the dashboard link dropped — the bot may still be in the server.
    // Keep the last known bot state on the chip; the dot communicates the
    // dashboard being offline.
    renderDash(false);
  });

  socket.on('bot:state', (snap) => {
    if (!snap) return;
    renderState(snap.state);
    if (snap.config) renderConfig(snap.config);
    if (snap.latencyMs !== undefined && snap.latencyMs !== null) renderLatency(snap.latencyMs);
  });

  socket.on('bot:stats', (stats) => {
    if (stats && stats.latencyMs !== undefined && stats.latencyMs !== null) {
      renderLatency(stats.latencyMs);
    }
  });

  socket.on('config:loaded', (cfg) => renderConfig(cfg));

  socket.on('config:updated', (cfg) => renderConfig(cfg));

  // ---- REST fallback ------------------------------------------------
  // If socket events are delayed (or the socket layer is flaky behind a
  // proxy / on Render), pull the current config + bot state once over plain
  // HTTP so the bar never sits on "—". The socket events above then refresh
  // it live. Both fetches are same-origin, so the session cookie is sent
  // automatically and they are auth-protected server-side.
  fetch('/api/config', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (d && d.config) renderConfig(d.config); })
    .catch(() => {});
  fetch('/api/bot/state', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.state) {
        renderState(d.state.state);
        renderConfig(d.state.config);
        if (d.state.latencyMs !== undefined && d.state.latencyMs !== null) renderLatency(d.state.latencyMs);
      }
    })
    .catch(() => {});

  // Initial paint (before any push arrives).
  renderState('stopped');
  renderLatency(null);
})();
