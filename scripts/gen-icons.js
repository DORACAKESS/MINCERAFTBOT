'use strict';
/* gen-icons.js — build public/js/icons.js (a shared client-side helper that
   returns inline Tabler SVG markup) from node_modules/@tabler/icons.
   Run `node scripts/gen-icons.js` after upgrading @tabler/icons. */
const fs = require('fs');
const path = require('path');
// scripts/gen-icons.js lives in scripts/, so the project root is one level up.
const ROOT = path.join(__dirname, '..');
const ICON_DIR = path.join(ROOT, 'node_modules', '@tabler', 'icons', 'icons', 'outline');

// Every icon used by JS-generated UI across the dashboard.
const NEEDED = [
  'user', 'robot', 'plug', 'circle-check', 'circle-x', 'moon', 'alert-triangle',
  'bolt', 'heart', 'meat', 'box', 'hand-grab', 'trash', 'message-circle',
  'info-circle', 'x', 'check', 'upload', 'tools', 'wand', 'pin', 'eye', 'pick',
  'search', 'walk', 'sun', 'key', 'clipboard', 'flask', 'edit', 'dice',
  'home', 'map-2', 'compass', 'backpack', 'brain', 'terminal-2', 'chart-bar',
  'building-skyscraper', 'device-gamepad', 'settings', 'globe', 'coin', 'run',
  'target', 'sparkles', 'map-pin', 'refresh', 'shield', 'skull',
  'book-2', 'antenna', 'door-exit', 'lock', 'users', 'chart-line', 'file-text',
  'device-desktop', 'star', 'recycle', 'swords', 'cap-rounded',
  'trophy', 'inbox', 'gift', 'folder', 'books', 'bulb', 'tag',
  'palette', 'cube', 'ban', 'send', 'stack-2', 'player-stop', 'player-play',
  'player-pause', 'logout', 'chevron-down', 'bread', 'shovel', 'arrow-up',
  'map-pin-2', 'device-floppy', 'target-arrow', 'history', 'clock'
];

const missing = [];
const paths = {};
for (const name of NEEDED) {
  const file = path.join(ICON_DIR, name + '.svg');
  let svg;
  try {
    svg = fs.readFileSync(file, 'utf8');
  } catch (_) {
    missing.push(name);
    continue;
  }
  // inner markup only (between <svg ...> and </svg>)
  const inner = svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  paths[name] = inner.trim();
}

if (missing.length) {
  console.error('MISSING ICONS:', missing.join(', '));
  process.exit(1);
}

const out = `'use strict';

/* ============================================================
   Shared inline-icon helper (Tabler outline icons, v3).
   Served via /js/icons.js; loaded FIRST on every page so page
   scripts can call mbIco() at module scope. Returns inline SVG
   markup so icons inherit the current text color (currentColor)
   — hover states, colored labels and buttons tint them for free.
   ============================================================ */

const MB_ICO_PATHS = ${JSON.stringify(paths, null, 0)};

/** Inline Tabler icon markup. name = outline icon file name (no .svg). */
window.mbIco = function mbIco(name, cls) {
  const inner = MB_ICO_PATHS[name];
  if (!inner) return '';
  return (
    '<svg class="tb-ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner + '</svg>'
  );
};
`;

fs.writeFileSync(path.join(ROOT, 'public', 'js', 'icons.js'), out);
console.log('wrote public/js/icons.js with', Object.keys(paths).length, 'icons');
console.log('missing:', missing.length ? missing.join(',') : 'none');
