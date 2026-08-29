'use strict';

/* ============================================================
   patch-viewer.js
   ---------------
   The prismarine-viewer web client ships as a single minified
   webpack bundle (public/index.js inside the package). We want a
   few extra powers without forking the whole library:

     1. Expose the viewer internals on window.__mb so our own
        viewer-patch.js (public/js/viewer-patch.js) can
        - teleport the camera to the bot ("move to bot")
        - add colored markers for bot / players / hostile / passive
        - draw the sky-locate beams (find-anything toggle)
        - cap the renderer pixel ratio + trim workers (performance)

     2. Colour the fallback entity boxes (the magenta cubes that
        appear when an entity has no 3D model) by type, matching
        the marker colours: players blue, hostiles red, others green.

   The two replacement anchors are verified unique in the pinned
   version (prismarine-viewer@1.33.0). Run with:
        node scripts/patch-viewer.js
   It writes the patched bundle to public/viewer/index.js, which is
   what the server serves at /viewer/index.js.

   If prismarine-viewer is ever upgraded, re-run this script (and
   re-verify the anchors below with: node -e "grep counts").
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(
  ROOT,
  'node_modules',
  'prismarine-viewer',
  'public',
  'index.js'
);
const OUT = path.join(ROOT, 'public', 'viewer', 'index.js');

if (!fs.existsSync(SRC)) {
  console.error('[patch-viewer] prismarine-viewer bundle not found:', SRC);
  process.exit(1);
}

let code = fs.readFileSync(SRC, 'utf8');

const replacements = [
  {
    // The web entry wires the viewer to the socket inside the
    // "version" handler. Expose a live handle so our patch script
    // can drive the camera/controls and listen to the same socket.
    //   v = Viewer instance   c = () => OrbitControls (live, may be
    //       null in first-person)   s = socket   r = renderer
    //   T = THREE (already on window via global.THREE, kept for clarity)
    find: 's=!0,u.listen(o)',
    replace: 's=!0,u.listen(o),window.__mb={v:u,c:()=>h,s:o,r:l,T:THREE}',
    note: 'expose viewer internals (window.__mb)'
  },
  {
    // Fallback entity box colour: magenta -> coloured by type + translucent
    // (so it reads as an entity marker instead of a solid crafting-table
    // block, which confused users: "Fern looks like a crafting table").
    //   player (username) -> blue    hostile mob name -> red
    //   everything else   -> green
    find: '{color:16711935}',
    replace:
      '{color:(void 0!==t.username?6332922:(t.name&&/(zombie|zombie_villager|drowned|husk|skeleton|stray|wither_skeleton|creeper|spider|cave_spider|enderman|endermite|silverfish|witch|blaze|ghast|magma_cube|slime|phantom|shulker|guardian|elder_guardian|vex|pillager|vindicator|evoker|illusioner|ravager|piglin|piglin_brute|hoglin|zoglin|warden|wither|ender_dragon|giant)/.test(t.name)?15678532:4906624)),transparent:!0,opacity:.45,depthWrite:!1}',
    note: 'type-coloured translucent fallback entity boxes'
  }
];

let failed = false;
for (const r of replacements) {
  const count = code.split(r.find).length - 1;
  if (count !== 1) {
    console.error(
      `[patch-viewer] anchor "${r.find}" found ${count} times (expected 1) — aborting.`
    );
    failed = true;
  }
}
if (failed) process.exit(1);

for (const r of replacements) code = code.split(r.find).join(r.replace);

// Safety net: the patched bundle must still be syntactically valid, otherwise
// the whole viewer page silently dies in the browser. (This caught a real bug
// once — an unbalanced parenthesis in a patch broke the entire bundle.)
try {
  // eslint-disable-next-line no-new-func
  new Function(code);
} catch (err) {
  console.error('[patch-viewer] PATCHED BUNDLE FAILED TO PARSE:', err.message);
  console.error('[patch-viewer] Aborting — public/viewer/index.js left untouched.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, code);

console.log(
  `[patch-viewer] OK — patched ${replacements.length} anchors -> ${path.relative(ROOT, OUT)}`
);
