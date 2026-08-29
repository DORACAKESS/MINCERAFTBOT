'use strict';

/* ============================================================
   reorder-nav.js — keep the sidebar consistent across pages
   ------------------------------------------------------------
   Rewrites the <nav> block in every public/*.html so all pages
   share the same menu order:

     1. Dashboard      ( / )
     2. 3D Map         ( /map.html )
     3. 2D Map         ( /map2d.html )
     4. Inventory      ( /inventory.html )
     5. AI Control     ( /ai.html )
     6. Commander      ( /commander.html )
     7. Console        ( /console.html )
     8. Statistics     ( /stats.html )
     9. Building       ( /building.html )
     ─────────────
     Settings         ( /settings.html )   ← always LAST (core settings)

   Each page marks its own link with `active`. Run:  node scripts/reorder-nav.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Ordered list: [href, emoji, label]
const ORDER = [
  ['/', '🏠', 'Dashboard'],
  ['/map.html', '🗺️', '3D Map'],
  ['/map2d.html', '🧭', '2D Map'],
  ['/inventory.html', '🎒', 'Inventory'],
  ['/ai.html', '🧠', 'AI Control'],
  ['/commander.html', '⚡', 'Commander'],
  ['/console.html', '💻', 'Console'],
  ['/stats.html', '📊', 'Statistics'],
  ['/building.html', '🏗️', 'Building'],
  ['/settings.html', '⚙️', 'Settings']
];

const labelFor = (href) => {
  const hit = ORDER.find(([h]) => h === href);
  return hit ? hit[2] : null;
};
const emojiFor = (href) => {
  const hit = ORDER.find(([h]) => h === href);
  return hit ? hit[1] : null;
};

function anchor(href, active) {
  const label = labelFor(href) || href;
  const emoji = emojiFor(href) || '🔗';
  return `      <a href="${href}" data-nav class="nav-item${active ? ' active' : ''}">
        <span class="text-base">${emoji}</span> ${label}
      </a>`;
}

function run() {
  const htmlFiles = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.html'));
  let changed = 0;

  for (const file of htmlFiles) {
    const p = path.join(PUBLIC_DIR, file);
    let html = fs.readFileSync(p, 'utf8');

    const navStart = html.indexOf('<nav ');
    const navEnd = html.indexOf('</nav>', navStart);
    if (navStart === -1 || navEnd === -1) continue;

    const navBlock = html.slice(navStart, navEnd + 6);
    const labelMatch = navBlock.match(/<p class="px-3 text-\[10px\][^>]*>([^<]*)<\/p>/);
    const menuLabel = labelMatch ? labelMatch[1] : 'Menu';
    const menuTag = `      <p class="px-3 text-[10px] uppercase tracking-[0.22em] text-slate-500 mb-3">${menuLabel}</p>\n`;

    // Which page is this? (the file's own route, except index.html -> /)
    const selfHref = file === 'index.html' ? '/' : `/${file}`;

    // Collect existing anchors (href + active state).
    const anchors = [];
    const anchorRe = /<a href="([^"]+)" data-nav class="nav-item([^"]*)">\s*<span class="text-base">[^<]*<\/span>\s*([^<]+)\s*<\/a>/g;
    let m;
    while ((m = anchorRe.exec(navBlock)) !== null) {
      anchors.push({ href: m[1], active: /active/.test(m[2]) });
    }
    if (!anchors.length) continue;

    // Rebuild in the canonical order; keep any unknown page appended
    // before Settings (so nothing is silently dropped).
    const known = ORDER.map(([h]) => h);
    const unknown = anchors.filter((a) => !known.includes(a.href)).map((a) => a.href);
    const settings = '/settings.html';

    const orderedHrefs = [
      ...known.filter((h) => h !== settings),
      ...unknown,
      settings
    ];

    const lines = [menuTag];
    for (const href of orderedHrefs) {
      const active = selfHref === href;
      lines.push(anchor(href, active));
      // Small visual break before Settings (core settings live at the bottom).
      if (href === settings && !file.includes('settings')) {
        lines.push('');
        lines.push('      <div class="my-2 border-t border-white/5"></div>');
      }
    }

    const newNav = `<nav class="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">\n${lines.join('\n')}\n    </nav>`;
    html = html.replace(navBlock, newNav);
    fs.writeFileSync(p, html, 'utf8');
    console.log(`  ✓ ${file}`);
    changed++;
  }

  console.log(`\nReordered nav in ${changed} page(s).`);
}

run();
