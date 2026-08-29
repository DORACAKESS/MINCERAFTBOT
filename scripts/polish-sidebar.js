'use strict';

/* ============================================================
   polish-sidebar.js — shared sidebar UI upgrade (idempotent)
   ------------------------------------------------------------
   Applies to every dashboard page (11 sidebar pages + login):
   1. Diamond SVG brand mark (theme-aware gradient box).
   2. Collapse-toggle button in the sidebar header.
   3. Grouped nav with divider labels (Main / World / Items /
      Intelligence / Tools / System), active state preserved.
   4. Footer cards + icon-only logout for the collapsed rail.
   5. Diamond SVG favicon (regex match — tolerant of emoji bytes).
   Safe to re-run: already-upgraded blocks are detected and skipped.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const PAGES = ['index', 'map', 'map2d', 'inventory', 'ai', 'commander', 'console', 'stats', 'building', 'controls', 'settings'];
const ALL_PAGES = PAGES.concat(['login', '404']);

const DIAMOND =
  '<svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 3h12l4 6.5L12 21 2 9.5 6 3z"/>' +
  '<path d="M2 9.5h20M6 3l4 6.5L12 21M18 3l-4 6.5L12 21"/></svg>';

const LOGIN_DIAMOND =
  '<svg class="w-7 h-7" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 3h12l4 6.5L12 21 2 9.5 6 3z"/>' +
  '<path d="M2 9.5h20M6 3l4 6.5L12 21M18 3l-4 6.5L12 21"/></svg>';

const OLD_HEADER = `    <div class="flex items-center gap-3 px-6 h-20 border-b border-white/5 shrink-0">
      <a href="/" class="w-10 h-10 grid place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/25 text-xl select-none">⛏️</a>
      <a href="/">
        <p class="font-pixel text-xs text-emerald-300 tracking-wide">MINEBOT</p>
        <p class="text-[11px] text-slate-500 mt-1.5">Dashboard v1.0</p>
      </a>
    </div>`;

const NEW_HEADER = `    <div class="sb-header flex items-center gap-3 px-6 h-20 border-b border-white/5 shrink-0">
      <a href="/" class="sb-logo w-10 h-10 shrink-0 grid place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/25 select-none" aria-label="MineBot dashboard home">${DIAMOND}</a>
      <div class="sb-brand min-w-0 flex-1">
        <p class="font-pixel text-xs text-emerald-300 tracking-wide">MINEBOT</p>
        <p class="text-[11px] text-slate-500 mt-1.5 truncate">Dashboard v1.0</p>
      </div>
      <button id="sb-collapse-btn" type="button" class="sb-collapse-btn w-8 h-8 shrink-0 grid place-items-center rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors" title="Collapse sidebar" aria-label="Toggle sidebar" aria-expanded="true">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 19l-7-7 7-7"/></svg>
      </button>
    </div>`;

const OLD_FOOTER = `    <div class="px-4 py-5 border-t border-white/5 shrink-0 space-y-3">
      <div class="rounded-xl bg-white/[0.03] border border-white/5 p-4">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-400">Dashboard server</span>
          <span id="conn-pill-sidebar" class="text-xs font-bold text-slate-500">○ Offline</span>
        </div>
        <p class="text-[11px] text-slate-500 mt-2">Node.js + Express + Socket.io</p>
      </div>
      <div class="rounded-xl bg-white/[0.03] border border-white/5 p-3 flex items-center justify-between gap-2">
        <span id="user-badge" class="text-xs text-slate-300 truncate">Loading…</span>
        <button id="logout-btn" class="btn btn-ghost text-xs px-3 py-1.5 shrink-0">Logout</button>
      </div>
    </div>`;

const NEW_FOOTER = `    <div class="sb-footer px-4 py-5 border-t border-white/5 shrink-0 space-y-3">
      <div class="sb-footer-card rounded-xl bg-white/[0.03] border border-white/5 p-4">
        <div class="flex items-center justify-between">
          <span class="text-xs text-slate-400">Dashboard server</span>
          <span id="conn-pill-sidebar" class="text-xs font-bold text-slate-500">○ Offline</span>
        </div>
        <p class="text-[11px] text-slate-500 mt-2">Node.js + Express + Socket.io</p>
      </div>
      <div class="sb-footer-user rounded-xl bg-white/[0.03] border border-white/5 p-3 flex items-center justify-between gap-2">
        <span id="user-badge" class="text-xs text-slate-300 truncate">Loading…</span>
        <button id="logout-btn" class="btn btn-ghost text-xs px-3 py-1.5 shrink-0">
          <svg class="sb-logout-ico w-0 h-0 overflow-hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>
          <span class="sb-logout-txt">Logout</span>
        </button>
      </div>
    </div>`;

const FAV_RE = /rel="icon" href="data:image\/svg\+xml,<svg xmlns=%22http:\/\/www\.w3\.org\/2000\/svg%22 viewBox=%220 0 100 100%22><text y=%22\.9em%22 font-size=%2290%22>[^<]*<\/text><\/svg>"/;

const NEW_FAVICON =
  'rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%2334d399%22 stroke-width=%222%22><path d=%22M6 3h12l4 6.5L12 21 2 9.5 6 3z%22/><path d=%22M2 9.5h20M6 3l4 6.5L12 21M18 3l-4 6.5L12 21%22/></svg>"';

const NEW_FAV_MARKER = 'viewBox=%220 0 24 24%22';

// Pre-paint sidebar state so collapsed users never see a flash of the
// expanded rail on page load (runs before any CSS paints the sidebar).
const OLD_BODY = '<body class="bg-[#070b12] text-slate-200 font-body antialiased min-h-screen">';
const NEW_BODY = OLD_BODY + "\n  <script>try{if(localStorage.getItem('mb-sb')==='1')document.body.classList.add('sb-collapsed')}catch(e){}</script>";

const GROUPS = [
  ['Main', ['/']],
  ['World', ['/map.html', '/map2d.html']],
  ['Items', ['/inventory.html']],
  ['Intelligence', ['/ai.html', '/commander.html']],
  ['Tools', ['/console.html', '/stats.html', '/building.html', '/controls.html']],
  ['System', ['/settings.html']]
];

const ANCHOR_RE = /<a href="(\/[^"]*)" data-nav class="nav-item([^"]*)"[^>]*>\s*<span class="text-base">([^<]*)<\/span>\s*([^<]*?)\s*<\/a>/g;

function read(p) { return fs.readFileSync(path.join(PUBLIC, p + '.html'), 'utf8'); }
function write(p, html) { fs.writeFileSync(path.join(PUBLIC, p + '.html'), html); }

const problems = [];

for (const page of PAGES) {
  let html = read(page);
  let changed = 0;
  const haveHeader = html.includes('sb-header');
  const haveNav = html.includes('sb-nav');
  const haveFooter = html.includes('sb-footer');

  if (!haveHeader) {
    if (html.includes(OLD_HEADER)) { html = html.split(OLD_HEADER).join(NEW_HEADER); changed++; }
    else problems.push(`${page}: header not found`);
  }

  if (!haveFooter) {
    if (html.includes(OLD_FOOTER)) { html = html.split(OLD_FOOTER).join(NEW_FOOTER); changed++; }
    else problems.push(`${page}: footer not found`);
  }

  if (!haveNav) {
    const anchors = [];
    let m;
    ANCHOR_RE.lastIndex = 0;
    while ((m = ANCHOR_RE.exec(html)) !== null) {
      anchors.push({ href: m[1], cls: m[2], icon: m[3], label: m[4].trim() });
    }
    if (anchors.length !== 11) {
      problems.push(`${page}: expected 11 nav anchors, found ${anchors.length}`);
    } else {
      let navInner = '';
      for (const [label, hrefs] of GROUPS) {
        navInner += `      <p class="sb-group-label">${label}</p>\n`;
        for (const href of hrefs) {
          const a = anchors.find((x) => x.href === href);
          if (!a) { problems.push(`${page}: no anchor for ${href}`); continue; }
          navInner += `      <a href="${a.href}" data-nav class="nav-item${a.cls}">\n        <span class="text-base">${a.icon}</span> ${a.label}\n      </a>\n`;
        }
      }
      const NEW_NAV = `    <nav class="sb-nav flex-1 px-4 py-5 space-y-1.5 overflow-y-auto">\n${navInner}    </nav>`;
      const navStart = html.indexOf('<nav class="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">');
      const navEnd = html.indexOf('</nav>');
      if (navStart === -1 || navEnd === -1 || navEnd < navStart) {
        problems.push(`${page}: nav block not found`);
      } else {
        html = html.slice(0, navStart) + NEW_NAV + html.slice(navEnd + '</nav>'.length);
        changed++;
      }
    }
  }

  if (FAV_RE.test(html)) { html = html.replace(FAV_RE, NEW_FAVICON); changed++; }
  else if (!html.includes(NEW_FAV_MARKER)) problems.push(`${page}: favicon not found`);

  if (html.includes(OLD_BODY)) { html = html.split(OLD_BODY).join(NEW_BODY); changed++; }
  else problems.push(`${page}: body tag not found`);

  write(page, html);
  console.log(`${page}: ${changed} block(s) rewritten`);
}

for (const page of ['login', '404']) {
  let html = read(page);
  let changed = 0;
  if (FAV_RE.test(html)) { html = html.replace(FAV_RE, NEW_FAVICON); changed++; }
  else if (!html.includes(NEW_FAV_MARKER)) problems.push(`${page}: favicon not found`);

  if (page === 'login') {
    const oldLogo = '<div class="w-12 h-12 grid place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/25 text-2xl select-none">⛏️</div>';
    if (!html.includes('w-7 h-7') && html.includes(oldLogo)) {
      html = html.split(oldLogo).join(`<div class="w-12 h-12 grid place-items-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 shadow-lg shadow-emerald-500/25 select-none">${LOGIN_DIAMOND}</div>`);
      changed++;
    }
  }
  write(page, html);
  console.log(`${page}: ${changed} block(s) rewritten`);
}

if (problems.length) {
  console.error('\nPROBLEMS:');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}
console.log('\nALL PAGES REWRITTEN OK');
