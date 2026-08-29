'use strict';

/* ============================================================
   One-time migration: Tailwind CDN → local stylesheet
   ------------------------------------------------------------
   Removes `<script src="https://cdn.tailwindcss.com">` and the
   inline `tailwind.config = {...}` block from every public HTML
   page and links the compiled `public/css/tailwind.css` instead.
   Idempotent — pages already migrated are left untouched.

   Run BEFORE/after `npm run build:css`:
       npm run build:css && node scripts/localize-tailwind.js
   ============================================================ */

const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const LINK = '<link rel="stylesheet" href="/css/tailwind.css" />';

// Inline config blocks all share this shape (whitespace varies a little).
const CONFIG_RE = /<script>\s*tailwind\.config\s*=\s*\{[\s\S]*?\};\s*<\/script>\s*/g;
const CDN_RE = /<script src="https:\/\/cdn\.tailwindcss\.com[^"]*"[^>]*><\/script>\s*/g;

let changed = 0;
let checked = 0;
for (const file of fs.readdirSync(PUBLIC)) {
  if (!file.endsWith('.html')) continue;
  const p = path.join(PUBLIC, file);
  let html = fs.readFileSync(p, 'utf8');
  checked += 1;
  const before = html;
  html = html.replace(CONFIG_RE, '');
  html = html.replace(CDN_RE, LINK + '\n  ');
  if (html !== before) {
    fs.writeFileSync(p, html);
    changed += 1;
    console.log('  • migrated', file);
  }
}
console.log(`Done — migrated ${changed} of ${checked} HTML pages to /css/tailwind.css.`);
