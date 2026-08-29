'use strict';

/* ============================================================
   MineBot — Building page logic
   ------------------------------------------------------------
   Library: upload / search / select / rename / delete builds.
   Details: material list with Minecraft block icons + counts.
   Build:   mode (survival / creative / operator), origin point,
            chest supply for survival, live progress bar.
   Preview: 3D voxel render of the build (three.js, same block
            textures the 3D map uses).
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
  stateBadge: $('build-state-badge'),
  name: $('build-name'),
  file: $('build-file'),
  fileName: $('build-file-name'),
  upload: $('build-upload'),
  uploadHint: $('build-upload-hint'),
  search: $('build-search'),
  list: $('build-list'),
  empty: $('build-empty'),
  detail: $('build-detail'),
  detailTitle: $('detail-title'),
  detailSub: $('detail-sub'),
  materials: $('detail-materials'),
  previewBtn: $('build-preview'),
  renameBtn: $('build-rename'),
  deleteBtn: $('build-delete'),
  modesWrap: $('build-modes'),
  modeHint: $('build-mode-hint'),
  originX: $('origin-x'),
  originY: $('origin-y'),
  originZ: $('origin-z'),
  originBot: $('origin-use-bot'),
  chestRow: $('chest-row'),
  chestEnabled: $('chest-enabled'),
  chestX: $('chest-x'),
  chestY: $('chest-y'),
  chestZ: $('chest-z'),
  chestNearest: $('chest-nearest'),
  speedWrap: $('build-speed'),
  verifyInput: $('build-verify'),
  progressWrap: $('build-progress-wrap'),
  progressMsg: $('build-progress-msg'),
  progressCount: $('build-progress-count'),
  progressBar: $('build-progress-bar'),
  startBtn: $('build-start'),
  stopBtn: $('build-stop'),
  giveBtn: $('build-give'),
  note: $('build-note'),
  toasts: $('toasts'),
  // Preview overlay
  previewOverlay: $('preview-overlay'),
  previewTitle: $('preview-title'),
  previewSub: $('preview-sub'),
  previewClose: $('preview-close'),
  previewCanvas: $('preview-canvas'),
  previewLoading: $('preview-loading')
};

let isAdmin = false;
let builds = [];
let selected = null; // manifest entry
let buildMode = 'survival';
let buildSpeed = 160; // ms per block (default Normal)
let previewThree = null; // { renderer, scene, camera, controls, raf }

const MODE_HINTS = {
  survival: 'Survival uses materials from the bot\u2019s inventory (plus a chest if enabled).',
  creative: 'Creative places directly and auto-gives any missing materials via /give (needs operator).',
  operator: 'Operator builds with /fill + /setblock commands — fastest for large builds.'
};

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
    setAdminState();
    if (!isAdmin) toast('Guests can browse builds and preview them — only admins can upload, build or give items.', 'info');
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
  socket.emit('building:list', (r) => {
    if (r && r.ok) applyList(r.list);
  });
});
socket.on('disconnect', () => setConnPills(false));

socket.on('building:list', (r) => {
  if (r && r.ok) applyList(r.list);
});
socket.on('building:updated', (r) => {
  if (r && Array.isArray(r.list)) applyList(r.list);
});
socket.on('building:progress', (p) => {
  if (!p || p.buildId !== (selected && selected.id)) return;
  renderProgress(p);
});

/* ---------- Library ---------- */

function applyList(list) {
  builds = Array.isArray(list) ? list : [];
  els.stateBadge.textContent = builds.length
    ? `${builds.length} build${builds.length === 1 ? '' : 's'} in library`
    : 'library empty';
  els.stateBadge.className = 'badge shrink-0 ' + (builds.length ? 'badge-emerald' : 'badge-slate');
  renderList();
  // Keep the selection alive if it still exists.
  if (selected) {
    const still = builds.find((b) => b.id === selected.id);
    if (still) {
      selected = still;
      renderDetail();
    } else {
      selectBuild(null);
    }
  }
}

function renderList() {
  const q = els.search.value.trim().toLowerCase();
  const filtered = builds.filter((b) => b.name.toLowerCase().includes(q));
  els.list.innerHTML = '';
  if (!filtered.length) {
    els.list.innerHTML = `<p class="text-xs text-slate-500 py-2">${builds.length ? 'No builds match your search.' : 'Upload a build to get started.'}</p>`;
    return;
  }
  for (const b of filtered) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className =
      'w-full text-left rounded-xl bg-white/[0.03] border border-white/5 px-4 py-3 transition-all ' +
      (selected && selected.id === b.id
        ? 'border-emerald-400/60 bg-emerald-500/[0.06] shadow-lg shadow-emerald-500/10'
        : 'hover:bg-white/[0.05] hover:border-white/10');
    row.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-9 h-9 rounded-lg grid place-items-center bg-slate-800/80 text-base select-none">${mbIco('building-skyscraper')}</span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-bold text-slate-100 truncate">${escapeHtml(b.name)}</p>
          <p class="text-[10px] text-slate-500 uppercase tracking-wider mt-0.5">
            ${escapeHtml(b.format)} · ${b.size ? `${b.size.x}×${b.size.y}×${b.size.z}` : '?'} · ${(b.blockCount || 0).toLocaleString()} blocks
          </p>
        </div>
        <span class="text-[11px] text-slate-500 font-mono shrink-0">${(b.materialCount || 0)} mats</span>
      </div>
    `;
    row.addEventListener('click', () => selectBuild(b));
    els.list.appendChild(row);
  }
}

els.search.addEventListener('input', renderList);

function selectBuild(b) {
  selected = b || null;
  renderList();
  els.empty.classList.toggle('hidden', !!selected);
  els.detail.classList.toggle('hidden', !selected);
  if (selected) {
    socket.emit('building:get', { id: selected.id }, (r) => {
      if (r && r.ok) {
        selected = r.build;
        renderDetail();
      }
    });
  }
}

/* ---------- Details / materials ---------- */

/* ---------- Block texture resolution ----------
   The viewer serves per-block PNGs from /viewer/textures/<v>/blocks/. A
   plain `blocks/{name}.png` URL fails for many blocks because:
     1. the version folder may not exist for the build's MC version, and
     2. the PNGs use resource-pack file names, not block names — e.g.
        grass_block → grass_block_top, chest → chest_front, spruce_slab →
        spruce_planks (slabs/stairs/walls reuse the base block texture).
   The resolver tries candidate names across several version folders, then
   falls back to a flat colour / letter tile. Shared by material icons and
   the 3D preview. */

const TEX_FOLDERS = ['1.21.4', '1.21.1', '1.20.1', '1.19', '1.18.1', '1.17.1', '1.16.4', '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.11.2', '1.10.2', '1.8.8'];

function texVersionFor(build) {
  const raw = String((build && build.version) || '');
  const m = raw.match(/^(\d+)\.(\d+)/);
  if (!m) return '1.16.4';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  for (const f of TEX_FOLDERS) {
    const fm = f.match(/^(\d+)\.(\d+)/);
    if (fm && Number(fm[1]) === major && Number(fm[2]) === minor) return f;
  }
  let best = null;
  for (const f of TEX_FOLDERS) {
    const fm = f.match(/^(\d+)\.(\d+)/);
    if (!fm || Number(fm[1]) !== major || Number(fm[2]) > minor) continue;
    if (!best || Number(fm[2]) > Number(best.match(/^(\d+)\.(\d+)/)[2])) best = f;
  }
  return best || '1.16.4';
}

/** Candidate texture file names for a block (best first). `side` prefers the
    block's SIDE texture (grass-like blocks) instead of the top. */
const TEX_WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'crimson', 'warped', 'bamboo', 'pale_oak'];
const TEX_FACE = {
  barrel: 'barrel_side', grindstone: 'grindstone_side', blast_furnace: 'blast_furnace_front',
  smoker: 'smoker_front', furnace: 'furnace_front', crafting_table: 'crafting_table_front',
  dispenser: 'dispenser_front', dropper: 'dropper_front', observer: 'observer_front', bookshelf: 'bookshelf'
};
const TEX_PLANT_TOP = ['lilac', 'tall_grass', 'peony', 'rose_bush', 'sunflower', 'large_fern', 'small_dripleaf', 'big_dripleaf', 'pitcher_plant'];

function texCandidates(name, side = false) {
  const n = String(name || '').trim().toLowerCase().replace(/^minecraft:/, '');
  const out = [];
  const push = (x) => { if (x && !out.includes(x)) out.push(x); };
  push(n);

  // Shape variants reuse the base block's texture.
  const base = n.replace(/_(slab|stairs|wall|fence|fence_gate|button|pressure_plate)$/, '');
  if (base !== n) {
    push(base);
    // Stone-family bases pluralize: deepslate_brick -> deepslate_bricks.
    if (base.endsWith('_brick') || base.endsWith('_tile')) push(base + 's');
    // Wood-family bases reuse the planks / log textures.
    const woodBase = TEX_WOODS.find((w) => base === w || base.startsWith(w + '_'));
    if (woodBase) {
      push(woodBase + '_planks');
      push(woodBase + '_log');
    }
  }
  // Wood shapes without a base (wall_sign / hanging_sign / trapdoor) -> planks.
  const wood = TEX_WOODS.find((w) => n.startsWith(w + '_'));
  if (wood && /_(wall_sign|hanging_sign|trapdoor)$/.test(n)) push(wood + '_planks');

  // Functional blocks with several textures: use the recognizable face.
  if (TEX_FACE[n]) push(TEX_FACE[n]);

  // Two-block plants: the top half is the recognizable texture.
  if (TEX_PLANT_TOP.includes(n)) push(n + '_top');

  // Potted plants use the plant's own texture.
  if (n.startsWith('potted_')) push(n.replace(/^potted_/, ''));

  // Carpets and beds have no block texture — matching wool reads well.
  if (n.endsWith('_carpet')) push(n.replace(/_carpet$/, '_wool'));
  if (n.endsWith('_bed')) push(n.replace(/_bed$/, '_wool'));

  // Panes render as the matching glass block.
  if (n.endsWith('_glass_pane')) push(n.replace(/_pane$/, ''), 'glass');
  if (n === 'glass_pane') push('glass');

  // Grass-like blocks: side texture for block sides, top texture for the top face.
  if (n === 'grass_block') {
    if (side) push('grass_block_side', 'grass_block', 'grass_block_top', 'grass');
    else push('grass_block_top', 'grass_block_side', 'grass_block', 'grass');
  }
  if (['podzol', 'mycelium', 'dirt_path', 'farmland'].includes(n)) {
    if (side) push(n, n + '_top');
    else push(n + '_top', n);
  }

  // Chests: the recognizable front face.
  if (n === 'chest' || n === 'trapped_chest' || n === 'ender_chest') push(n + '_front');

  // Doors: top-half texture.
  if (n.endsWith('_door')) push(n.replace(/_door$/, '_door_top'));

  return out;
}

/** Ordered list of texture URLs to try for a block (best first). */
function texUrls(name, build, side = false) {
  const first = texVersionFor(build);
  const versions = [first, ...TEX_FOLDERS.filter((v) => v !== first)];
  const urls = [];
  for (const v of versions) {
    for (const c of texCandidates(name, side)) {
      urls.push(`/viewer/textures/${v}/blocks/${encodeURIComponent(c)}.png`);
    }
  }
  return urls;
}

// Chained onerror: walk the candidate URLs, then swap in the letter tile.
window.__texFallback = function (img, urls, fallbackHtml, i) {
  if (i >= urls.length) {
    img.outerHTML = fallbackHtml;
    return;
  }
  img.onerror = () => window.__texFallback(img, urls, fallbackHtml, i + 1);
  img.src = urls[i];
};

function materialIcon(name, build) {
  // Keep the icon's inline URL list lean (preferred version + a couple of
  // fallback folders) — plenty for a 36px icon.
  const urls = texUrls(name, build).slice(0, 12);
  const letters = escapeHtml((name.slice(0, 2) || '?').toUpperCase());
  // Tint the letter tile with the block's real colour so even texture-less
  // blocks (chests, signs…) show a recognizable hint instead of a grey box.
  const bc = blockColor(name);
  const tint = '#' + (bc >>> 0).toString(16).padStart(6, '0');
  const fallback = `<span class="w-9 h-9 rounded-lg grid place-items-center text-[10px] font-bold select-none" style="background:${tint}22;color:${tint};border:1px solid ${tint}55">${letters}</span>`;
  // The JSON payloads live inside a double-quoted HTML attribute, so their
  // double quotes must be HTML-entity escaped (the browser un-escapes them
  // back into a valid JSON string before the handler runs).
  const urlsJson = JSON.stringify(urls).replace(/"/g, '&quot;');
  const fbJson = JSON.stringify(fallback).replace(/"/g, '&quot;');
  return `<img src="${urls[0]}" alt="${escapeHtml(name)}" loading="lazy"
    class="w-9 h-9 rounded object-contain bg-slate-900/60 ring-1 ring-white/10"
    style="image-rendering:pixelated"
    onerror="window.__texFallback(this,${urlsJson},${fbJson},1)">`;
}

function renderDetail() {
  if (!selected) return;
  els.detailTitle.innerHTML = `${mbIco('building-skyscraper')} ${selected.name}`;
  const extra = [];
  if (selected.blockEntityCount > 0) extra.push(`${selected.blockEntityCount} with data (signs/chests)`);
  if (selected.entityCount > 0) extra.push(`${selected.entityCount} entities`);
  els.detailSub.textContent =
    `${selected.format} · ${selected.size ? `${selected.size.x}×${selected.size.y}×${selected.size.z}` : '?'} · ` +
    `${(selected.blockCount || 0).toLocaleString()} blocks · ${(selected.materialCount || 0)} material types` +
    (extra.length ? ` · ${extra.join(' · ')}` : '');
  els.materials.innerHTML = '';
  const mats = selected.materials || [];
  if (!mats.length) {
    els.materials.innerHTML = '<p class="text-xs text-slate-500 col-span-3">No materials recorded for this build.</p>';
  } else {
    for (const m of mats) {
      const tile = document.createElement('div');
      tile.className =
        'flex items-center gap-2.5 rounded-xl bg-white/[0.03] border border-white/5 px-3 py-2 group hover:border-white/10 transition-colors';
      tile.innerHTML = `
        ${materialIcon(m.name, selected)}
        <div class="min-w-0">
          <p class="text-[12px] font-bold text-slate-200 truncate">${escapeHtml(prettyName(m.name))}</p>
          <p class="text-[10px] text-slate-500 font-mono">${Number(m.count).toLocaleString()}</p>
        </div>
      `;
      els.materials.appendChild(tile);
    }
  }
  // Chest supply only matters for survival.
  els.chestRow.classList.toggle('opacity-50 pointer-events-none', buildMode !== 'survival');
}

els.renameBtn.addEventListener('click', () => {
  if (!isAdmin) return toast('Admin permission required.', 'error');
  if (!selected) return;
  const next = prompt('Rename this build:', selected.name);
  if (next === null || !next.trim() || next.trim() === selected.name) return;
  socket.emit('building:rename', { id: selected.id, name: next.trim() }, (r) => {
    if (r && r.ok) toast('Build renamed.', 'success');
    else toast(((r && r.errors) || ['Could not rename.'])[0], 'error');
  });
});

els.deleteBtn.addEventListener('click', () => {
  if (!isAdmin) return toast('Admin permission required.', 'error');
  if (!selected) return;
  if (!confirm(`Delete "${selected.name}" from the library?`)) return;
  socket.emit('building:delete', { id: selected.id }, (r) => {
    if (r && r.ok) {
      toast('Build deleted.', 'success');
      selectBuild(null);
    } else toast(((r && r.errors) || ['Could not delete.'])[0], 'error');
  });
});

/* ---------- Upload ---------- */

els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  els.fileName.textContent = f ? `${f.name} (${(f.size / 1024).toFixed(1)} KB)` : 'No file selected.';
  if (f && !els.name.value.trim()) {
    els.name.value = f.name.replace(/\.(schem|schematic|litematic)$/i, '').slice(0, 60);
  }
});

els.upload.addEventListener('click', () => {
  if (!isAdmin) return toast('Admin permission required.', 'error');
  const f = els.file.files && els.file.files[0];
  if (!f) return toast('Pick a file first.', 'error');
  const name = els.name.value.trim();
  if (!name) return toast('Give the build a name.', 'error');
  els.upload.disabled = true;
  els.upload.innerHTML = mbIco('clock') + ' Parsing…';
  f.arrayBuffer()
    .then((buf) => {
      socket.emit('building:upload', { name, fileName: f.name, data: buf }, (r) => {
        els.upload.disabled = false;
        els.upload.innerHTML = mbIco('upload') + ' Upload';
        if (r && r.ok) {
          toast(`"${name}" uploaded — ${r.build.blockCount.toLocaleString()} blocks, ${r.build.materialCount} materials.`, 'success');
          els.file.value = '';
          els.fileName.textContent = 'No file selected.';
          els.name.value = '';
          selectBuild(r.build);
        } else {
          ((r && r.errors) || ['Could not upload the file.']).forEach((e) => toast(e, 'error'));
        }
      });
    })
    .catch(() => {
      els.upload.disabled = false;
      els.upload.innerHTML = mbIco('upload') + ' Upload';
      toast('Could not read the file.', 'error');
    });
});

/* ---------- Build controls ---------- */

els.modesWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  buildMode = btn.dataset.mode;
  els.modesWrap.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('btn-primary', b === btn);
    b.classList.toggle('btn-ghost', b !== btn);
  });
  els.modeHint.textContent = MODE_HINTS[buildMode] || '';
  els.chestRow.classList.toggle('opacity-50 pointer-events-none', buildMode !== 'survival');
});

// Speed presets (ms per block).
els.speedWrap.addEventListener('click', (e) => {
  const btn = e.target.closest('.speed-btn');
  if (!btn) return;
  buildSpeed = Number(btn.dataset.speed) || 160;
  els.speedWrap.querySelectorAll('.speed-btn').forEach((b) => {
    b.classList.toggle('btn-primary', b === btn);
    b.classList.toggle('btn-ghost', b !== btn);
  });
});
// Default selection = Normal.
{
  const normal = els.speedWrap.querySelector('[data-speed="160"]');
  if (normal) {
    normal.classList.remove('btn-ghost');
    normal.classList.add('btn-primary');
  }
}

let lastBotPos = null; // latest position from the 2D radar stream

socket.on('bot:radar', (r) => {
  if (!r || !r.bot) return;
  lastBotPos = { x: r.bot.x, y: r.bot.y, z: r.bot.z };
  // Prefill the origin once, only while the user isn't typing.
  const typing = document.activeElement && isOriginInput(document.activeElement);
  if (!typing && els.originX.value === '' && els.originY.value === '' && els.originZ.value === '') {
    els.originX.value = Math.floor(r.bot.x);
    els.originY.value = Math.floor(r.bot.y);
    els.originZ.value = Math.floor(r.bot.z);
  }
});

els.originBot.addEventListener('click', () => {
  if (lastBotPos) {
    els.originX.value = Math.floor(lastBotPos.x);
    els.originY.value = Math.floor(lastBotPos.y);
    els.originZ.value = Math.floor(lastBotPos.z);
    toast('Origin set to the bot position.', 'success');
  } else {
    toast('Bot is not in a server — type the origin manually.', 'error');
  }
});

function isOriginInput(el) {
  return el && [els.originX, els.originY, els.originZ, els.chestX, els.chestY, els.chestZ].includes(el);
}

function buildOptions() {
  const num = (el, d) => {
    const v = Number(el.value);
    return Number.isInteger(v) ? v : d;
  };
  return {
    id: selected.id,
    mode: buildMode,
    origin: { x: num(els.originX, 0), y: num(els.originY, 64), z: num(els.originZ, 0) },
    speed: buildSpeed,
    verify: {
      enabled: !!els.verifyInput && els.verifyInput.checked,
      passes: 3
    },
    chest: {
      enabled: buildMode === 'survival' && els.chestEnabled.checked,
      pos:
        els.chestEnabled.checked && !els.chestNearest.checked
          ? { x: num(els.chestX, 0), y: num(els.chestY, 64), z: num(els.chestZ, 0) }
          : null,
      findNearest: els.chestEnabled.checked && els.chestNearest.checked
    }
  };
}

els.startBtn.addEventListener('click', () => {
  if (!isAdmin) return toast('Admin permission required.', 'error');
  if (!selected) return toast('Select a build first.', 'error');
  socket.emit('building:build', buildOptions(), (r) => {
    if (r && r.ok) toast('Build started — watch the progress bar.', 'success');
    else toast(((r && r.errors) || ['Could not start the build.'])[0], 'error');
  });
});

els.stopBtn.addEventListener('click', () => {
  socket.emit('building:stop', {}, (r) => {
    if (r && r.ok) toast('Stopping build…', 'info');
  });
});

els.giveBtn.addEventListener('click', () => {
  if (!isAdmin) return toast('Admin permission required.', 'error');
  if (!selected) return toast('Select a build first.', 'error');
  socket.emit('building:give', { id: selected.id }, (r) => {
    if (r && r.ok) toast(`Gave ${r.materials} material types to the bot.`, 'success');
    else toast(((r && r.errors) || ['Could not give items.'])[0], 'error');
  });
});

/* ---------- Progress ---------- */

// Verify phases colour the bar differently so the user can tell scanning
// (verify), fixing and the final result apart at a glance.
function renderProgress(p) {
  els.progressWrap.classList.remove('hidden');
  els.startBtn.classList.add('hidden');
  els.stopBtn.classList.remove('hidden');
  const total = p.total || 1;
  const done = Math.min(total, p.placed || 0);
  els.progressMsg.textContent = p.message || '';
  els.progressCount.textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  els.progressBar.style.width = `${Math.round((done / total) * 100)}%`;
  els.progressBar.className =
    'h-full rounded-full transition-all duration-300 ' +
    (p.phase === 'verify'
      ? 'bg-gradient-to-r from-sky-400 to-indigo-500'
      : p.phase === 'fixing'
        ? 'bg-gradient-to-r from-amber-400 to-orange-500'
        : p.phase === 'verified'
          ? 'bg-gradient-to-r from-emerald-400 to-teal-500'
          : p.phase === 'verify-failed'
            ? 'bg-gradient-to-r from-rose-500 to-red-600'
            : 'bg-gradient-to-r from-emerald-400 to-teal-500');
  if (p.phase === 'done' || p.phase === 'error' || p.phase === 'stopped' || p.phase === 'verified' || p.phase === 'verify-failed') {
    setTimeout(() => {
      els.progressWrap.classList.add('hidden');
      els.startBtn.classList.remove('hidden');
      els.stopBtn.classList.add('hidden');
      els.progressBar.style.width = '0%';
      if (p.phase === 'done') toast(mbIco('circle-check') + ' Build finished.', 'success');
      if (p.phase === 'verified') toast(mbIco('circle-check') + ' Build verified clean.', 'success');
      if (p.phase === 'verify-failed') toast(`${mbIco('alert-triangle')} ${p.message || 'Some blocks still need fixing.'}`, 'error');
      if (p.phase === 'error') toast(`${mbIco('alert-triangle')} ${p.message || 'Build failed.'}`, 'error');
    }, 1500);
  }
}

/* ---------- 3D Preview ---------- */

let previewPromise = null;

function loadThree() {
  if (window.THREE) return Promise.resolve();
  if (previewPromise) return previewPromise;
  previewPromise = new Promise((resolve, reject) => {
    const base = 'https://unpkg.com/three@0.128.0';
    const s = document.createElement('script');
    s.src = `${base}/build/three.min.js`;
    s.onload = () => {
      const o = document.createElement('script');
      o.src = `${base}/examples/js/controls/OrbitControls.js`;
      o.onload = () => resolve();
      o.onerror = () => reject(new Error('Could not load OrbitControls.'));
      document.head.appendChild(o);
    };
    s.onerror = () => reject(new Error('Could not load three.js (offline?).'));
    document.head.appendChild(s);
  });
  return previewPromise;
}

els.previewBtn.addEventListener('click', openPreview);
els.previewClose.addEventListener('click', closePreview);

async function openPreview() {
  if (!selected) return;
  els.previewOverlay.classList.remove('hidden');
  els.previewTitle.textContent = `Preview — ${selected.name}`;
  els.previewLoading.textContent = 'Loading 3D preview…';
  els.previewLoading.classList.remove('hidden');

  socket.emit('building:preview', { id: selected.id }, async (r) => {
    if (!r || !r.ok) {
      els.previewLoading.textContent = ((r && r.errors) || ['Could not load the preview.'])[0];
      return;
    }
    try {
      await loadThree();
      buildPreviewScene(r);
      els.previewLoading.classList.add('hidden');
    } catch (err) {
      els.previewLoading.textContent = err.message + ' Preview needs an internet connection for three.js.';
    }
  });
}

function closePreview() {
  els.previewOverlay.classList.add('hidden');
  if (previewThree) {
    cancelAnimationFrame(previewThree.raf);
    if (typeof previewThree.dispose === 'function') previewThree.dispose();
    previewThree.controls.dispose();
    // Free GPU resources: geometries, materials and textures of every mesh.
    previewThree.scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.geometry && obj.geometry.dispose();
        const mat = obj.material;
        if (mat) {
          if (Array.isArray(mat)) mat.forEach((m) => disposeMaterial(m));
          else disposeMaterial(mat);
        }
      }
    });
    previewThree.renderer.dispose();
    const holder = els.previewCanvas.querySelector('canvas');
    if (holder) holder.remove();
    previewThree = null;
  }
}

function disposeMaterial(mat) {
  if (!mat) return;
  const maps = [mat.map, mat.emissiveMap, mat.aoMap, mat.specularMap];
  maps.forEach((t) => t && t.dispose && t.dispose());
  mat.dispose && mat.dispose();
}

function buildPreviewScene(r) {
  const holder = els.previewCanvas;
  holder.querySelectorAll('canvas').forEach((c) => c.remove());
  const { size, blocks, truncated, totalBlocks } = r;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const w = holder.clientWidth || 800;
  const h = holder.clientHeight || 500;
  renderer.setSize(w, h);
  holder.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1120);

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 10000);
  const cx = size.x / 2;
  const cz = size.z / 2;
  const cy = size.y / 2;
  camera.position.set(cx + size.x * 0.9, cy + size.y * 1.6 + 8, cz + size.z * 1.1);
  camera.lookAt(cx, cy, cz);

  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(cx, cy, cz);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(40, 90, 30);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x404060, 0.5));

  // Floor grid for orientation.
  const grid = new THREE.GridHelper(Math.max(size.x, size.z) + 12, 24, 0x334155, 0x1e293b);
  grid.position.set(cx, -0.5, cz);
  scene.add(grid);

  // Voxel shell rendering: only faces that border air are drawn, so touching
  // blocks never z-fight (the flicker/glitch), slabs render half-height, and
  // grass-like blocks get their correct top texture.
  const occ = new Set();
  const slabKeys = new Set();
  const key = (x, y, z) => x + ',' + y + ',' + z;
  for (const b of blocks) {
    occ.add(key(b.x, b.y, b.z));
    if (String(b.name).endsWith('_slab')) slabKeys.add(key(b.x, b.y, b.z));
  }

  const loader = new THREE.TextureLoader();
  const FACE_DIRS = [
    { dx: 1, dy: 0, dz: 0, geom: new THREE.BoxGeometry(0.06, 1, 1), ox: 0.5, oy: 0, oz: 0, top: false },
    { dx: -1, dy: 0, dz: 0, geom: new THREE.BoxGeometry(0.06, 1, 1), ox: -0.5, oy: 0, oz: 0, top: false },
    { dx: 0, dy: 1, dz: 0, geom: new THREE.BoxGeometry(1, 0.06, 1), ox: 0, oy: 0.5, oz: 0, top: true },
    { dx: 0, dy: -1, dz: 0, geom: new THREE.BoxGeometry(1, 0.06, 1), ox: 0, oy: -0.5, oz: 0, top: false },
    { dx: 0, dy: 0, dz: 1, geom: new THREE.BoxGeometry(1, 1, 0.06), ox: 0, oy: 0, oz: 0.5, top: false },
    { dx: 0, dy: 0, dz: -1, geom: new THREE.BoxGeometry(1, 1, 0.06), ox: 0, oy: 0, oz: -0.5, top: false }
  ];
  const TOP_TEX = new Set(['grass_block', 'podzol', 'mycelium', 'dirt_path', 'farmland']);

  // Functional blocks get their real per-face textures (front / back / side /
  // top / bottom) so furnaces, barrels, chests etc. read correctly in the
  // preview instead of one flat colour or the front texture smeared over
  // every face. Chests have no texture in the viewer at all — the oak planks
  // fallback reads as a wooden container and stays clearly visible. Missing
  // textures fall back to the block colour.
  const FACE_PLAN = {
    furnace:        ['furnace_front', 'furnace_side', 'furnace_side', 'furnace_top', 'furnace_top'],
    blast_furnace:  ['blast_furnace_front', 'blast_furnace_side', 'blast_furnace_side', 'blast_furnace_top', 'blast_furnace_top'],
    smoker:         ['smoker_front', 'smoker_side', 'smoker_side', 'smoker_top', 'smoker_top'],
    barrel:         ['barrel_side', 'barrel_side', 'barrel_side', 'barrel_top', 'barrel_bottom'],
    crafting_table: ['crafting_table_front', 'crafting_table_side', 'crafting_table_side', 'crafting_table_top', 'crafting_table_top'],
    bookshelf:      ['bookshelf', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
    dispenser:      ['dispenser_front', 'furnace_side', 'furnace_side', 'furnace_top', 'furnace_top'],
    dropper:        ['dropper_front', 'furnace_side', 'furnace_side', 'furnace_top', 'furnace_top'],
    observer:       ['observer_front', 'furnace_side', 'furnace_side', 'furnace_top', 'furnace_top'],
    hopper:         ['hopper_inside', 'hopper_outside', 'hopper_outside', 'hopper_outside', 'hopper_outside'],
    anvil:          ['anvil_top', 'anvil_top', 'anvil_top', 'anvil_top', 'anvil_top'],
    cauldron:       ['cauldron_inner', 'cauldron_inner', 'cauldron_inner', 'cauldron_inner', 'cauldron_inner'],
    brewing_stand:  ['brewing_stand', 'brewing_stand', 'brewing_stand', 'brewing_stand', 'brewing_stand'],
    chest:          ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks'],
    trapped_chest:  ['oak_planks', 'oak_planks', 'oak_planks', 'oak_planks', 'oak_planks']
  };

  const byName = new Map();
  for (const b of blocks) {
    if (!byName.has(b.name)) byName.set(b.name, []);
    byName.get(b.name).push(b);
  }

  for (const [name, list] of byName) {
    const grassLike = TOP_TEX.has(name);
    const plan = FACE_PLAN[name] || null;

    const makeMat = () => new THREE.MeshLambertMaterial({ color: blockColor(name) });
    // texName: a specific texture file name (e.g. 'furnace_front') tried
    // across version folders, or null to use the default resolver with the
    // `side` flag (grass-like blocks get their side texture on the sides).
    const applyTex = (mat, texName, side) => {
      let urls;
      if (typeof texName === 'string') {
        const first = texVersionFor(r.build);
        const versions = [first, ...TEX_FOLDERS.filter((v) => v !== first)];
        urls = versions.map((v) => `/viewer/textures/${v}/blocks/${encodeURIComponent(texName)}.png`);
      } else {
        urls = texUrls(name, r.build, side);
      }
      let ui = 0;
      const next = () => {
        if (ui >= urls.length) return; // keep the flat colour
        const u = urls[ui++];
        loader.load(
          u,
          (tex) => {
            // The preview may have been closed while the texture loaded —
            // don't paint onto a disposed material.
            if (!previewThree) { tex.dispose && tex.dispose(); return; }
            tex.magFilter = THREE.NearestFilter;
            tex.minFilter = THREE.NearestFilter;
            tex.encoding = THREE.sRGBEncoding;
            mat.map = tex;
            mat.color.set(0xffffff);
            mat.needsUpdate = true;
          },
          undefined,
          next
        );
      };
      next();
    };

    // Build the per-direction materials (functional blocks) or the main +
    // optional top pair (everything else).
    const mats = {};
    if (plan) {
      mats.front = makeMat(); applyTex(mats.front, plan[0]);
      mats.back = makeMat(); applyTex(mats.back, plan[1]);
      mats.side = makeMat(); applyTex(mats.side, plan[2]);
      mats.top = makeMat(); applyTex(mats.top, plan[3]);
      mats.bottom = makeMat(); applyTex(mats.bottom, plan[4]);
    } else {
      mats.main = makeMat();
      applyTex(mats.main, null, grassLike);
      if (grassLike) {
        mats.top = makeMat();
        applyTex(mats.top, null, false);
      }
    }
    const matForDir = (dir) => {
      if (plan) {
        if (dir.dy === 1) return mats.top;
        if (dir.dy === -1) return mats.bottom;
        if (dir.dz === 1) return mats.front;
        if (dir.dz === -1) return mats.back;
        return mats.side; // ±x faces
      }
      return dir.top && mats.top ? mats.top : mats.main;
    };

    const isSlab = name.endsWith('_slab');
    const mtx = new THREE.Matrix4();

    for (const dir of FACE_DIRS) {
      const instances = [];
      for (const b of list) {
        // Cull faces that border another block. A slab's top face is only
        // covered when another slab sits directly above it (a full block at
        // y+1 floats 0.5 higher and the face stays visible).
        if (dir.dy === 1 && isSlab) {
          if (slabKeys.has(key(b.x, b.y + 1, b.z))) continue;
        } else if (occ.has(key(b.x + dir.dx, b.y + dir.dy, b.z + dir.dz))) {
          continue;
        }
        // Face plane position (on the block boundary).
        const px = b.x + 0.5 + dir.ox;
        const pz = b.z + 0.5 + dir.oz;
        let py;
        let scaleY = 1;
        if (dir.dy === 0) {
          py = b.y + (isSlab ? 0.25 : 0.5);
          if (isSlab) scaleY = 0.5;
        } else {
          py = b.y + (isSlab ? (dir.dy > 0 ? 0.5 : 0) : (dir.dy > 0 ? 1 : 0));
        }
        mtx.makeScale(1, scaleY, 1);
        mtx.setPosition(px, py, pz);
        instances.push(mtx.clone());
      }
      if (!instances.length) continue;
      const mat = matForDir(dir);
      const mesh = new THREE.InstancedMesh(dir.geom, mat, instances.length);
      for (let i = 0; i < instances.length; i++) mesh.setMatrixAt(i, instances[i]);
      mesh.instanceMatrix.needsUpdate = true;
      scene.add(mesh);
    }
  }

  els.previewSub.textContent = `${size.x}×${size.y}×${size.z} · ${blocks.length.toLocaleString()} blocks shown` +
    (truncated ? ` · (of ${totalBlocks.toLocaleString()} — preview capped)` : '') +
    ' · drag to orbit, scroll to zoom';

  let raf;
  const animate = () => {
    raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const onResize = () => {
    const nw = holder.clientWidth || 800;
    const nh = holder.clientHeight || 500;
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
    renderer.setSize(nw, nh);
  };
  window.addEventListener('resize', onResize);

  previewThree = { renderer, scene, camera, controls, raf, dispose: () => window.removeEventListener('resize', onResize) };
}

/* ---------- Block colour fallback ----------
   Real-ish Minecraft colours used when a texture can't be loaded — many
   blocks (chests especially) have NO texture in the viewer at all, so the
   old hash palette gave them arbitrary colours (ender_chest → lime green,
   signs → near-black) that vanished against the dark background. Exact
   names win, then colour-named families (wool/concrete/shulker…), then
   material families, then a BRIGHT hash so nothing ever renders dark
   enough to be invisible. */

const BLOCK_COLORS = {
  // Functional / block-entity blocks — the ones textures usually miss.
  chest: 0xa06b3c, trapped_chest: 0xb07a45, ender_chest: 0x4a3d6e,
  furnace: 0x7a7a7a, blast_furnace: 0x5f5f5f, smoker: 0x4f4f4f,
  barrel: 0x6e4f2a, crafting_table: 0x8b5a2b, bookshelf: 0x8b5a2b,
  lectern: 0x8b5a2b, grindstone: 0x8f8f8f, stonecutter: 0x9aa0a6,
  sign: 0x8b5a2b, hopper: 0x7f8c8d, dispenser: 0x9aa0a6, dropper: 0x9aa0a6,
  observer: 0x8d8d8d, brewing_stand: 0x6a4a72, cauldron: 0x4a4a4a,
  anvil: 0x6f6f6f, beacon: 0x9fd8ff, lodestone: 0x5a5a5a, bell: 0xd4a017,
  campfire: 0x8b4513, lantern: 0xd4a017, torch: 0xd4a017, end_rod: 0xeee8aa,
  // Common full blocks.
  water: 0x2f6fb3, lava: 0xc94f1c, sand: 0xe3d18a, red_sand: 0xc96f3f,
  dirt: 0x7a5230, grass_block: 0x5aa83f, snow: 0xf0f4f8, ice: 0xa8d8ea,
  blue_ice: 0x8fc8e8, netherrack: 0x6b2f2f, soul_sand: 0x4a382a,
  soul_soil: 0x3f3026, end_stone: 0xe0dfc9, bedrock: 0x3d3d3d,
  obsidian: 0x23232e, gold_block: 0xe8c34a, iron_block: 0xdadada,
  diamond_block: 0x6fe3d8, emerald_block: 0x3fbf6f, redstone_block: 0xb91f1f,
  coal_block: 0x2f2f2f, lapis_block: 0x2f4f9f, copper_block: 0xc97d62,
  quartz_block: 0xf0e6dc, amethyst_block: 0xa56fd8, prismarine: 0x5fb0a0,
  sea_lantern: 0xe8e8d0, slime_block: 0x8fd86f, honey_block: 0xe8a82f,
  tnt: 0xc94f1f, hay_block: 0xd8b53f, bone_block: 0xe8e2d0, pumpkin: 0xd87f2f,
  melon: 0x7fc93f, cake: 0xf0e0d0, sponge: 0xc9c93f, glowstone: 0xe8c98a,
  shroomlight: 0xe8926a, mushroom_stem: 0xd8d0c0, brown_mushroom_block: 0x8a5a3a,
  red_mushroom_block: 0xb03a3a, red_sandstone: 0xc96f3f, red_nether_bricks: 0x8a2f2f,
  diamond_ore: 0x6db5d8, iron_ore: 0xb08a6a, gold_ore: 0xe8c34a, coal_ore: 0x4a4a4a,
  emerald_ore: 0x3fbf6f, redstone_ore: 0xb91f1f, lapis_ore: 0x2f4f9f,
  copper_ore: 0xc97d62, nether_gold_ore: 0x8a3a3a, glass: 0xbfe3e8,
  soul_lantern: 0x5f9ea0, oak_planks: 0x8b5a2b, spruce_planks: 0x5d3a1a,
  birch_planks: 0xc9b98c, jungle_planks: 0x9a6a3c, acacia_planks: 0xb0704a,
  dark_oak_planks: 0x4a2f12, mangrove_planks: 0x7a4a2e, cherry_planks: 0xe8b4b8,
  pale_oak_planks: 0xd8cfc0, crimson_planks: 0x6d2e3a, warped_planks: 0x3a7a6d,
  bamboo_planks: 0x7d9a3a
};

/* Minecraft dye colours, keyed by the colour word used in block names
   (white_wool, blue_concrete, magenta_shulker_box, …). */
const NAMED_COLORS = {
  white: 0xe8e8e8, light_gray: 0xa0a0a0, gray: 0x6f6f6f, black: 0x232323,
  brown: 0x6b4a2f, red: 0xb02f2f, orange: 0xe07f2f, yellow: 0xe8d03f,
  lime: 0x7fc93f, green: 0x3f7a2f, cyan: 0x2fa0a8, light_blue: 0x7fb8e8,
  blue: 0x2f4f9f, purple: 0x7a3fb8, magenta: 0xc03fc0, pink: 0xe8a0b8
};

/* Material families (ordered, most specific first). */
const BLOCK_FAMILY = [
  [/^oak_/, 0x8b5a2b], [/^spruce_/, 0x5d3a1a], [/^birch_/, 0xc9b98c],
  [/^jungle_/, 0x9a6a3c], [/^acacia_/, 0xb0704a], [/^dark_oak_/, 0x4a2f12],
  [/^mangrove_/, 0x7a4a2e], [/^cherry_/, 0xe8b4b8], [/^pale_oak_/, 0xd8cfc0],
  [/^crimson_/, 0x6d2e3a], [/^warped_/, 0x3a7a6d], [/^bamboo_/, 0x7d9a3a],
  [/^copper/, 0xc97d62], [/^quartz/, 0xf0e6dc], [/^prismarine/, 0x5fb0a0],
  [/^deepslate/, 0x4a4a52], [/^stone/, 0x8f8f8f], [/^cobblestone/, 0x7a7a7a],
  [/^mossy/, 0x5a7a3a], [/^diorite/, 0xd8d8d8], [/^andesite/, 0x8f8f8f],
  [/^granite/, 0x9a6a5a], [/^basalt/, 0x3d3d3d], [/^tuff/, 0x6a6a6a],
  [/^calcite/, 0xe8e8e8], [/^dripstone/, 0x8a6a4a], [/^smooth_/, 0x8f8f8f],
  [/^nether/, 0x6b2f2f], [/^end_stone/, 0xe0dfc9], [/^mud/, 0x4a3f2f],
  [/^clay/, 0x9aa0a8], [/^gravel/, 0x8a8a8a], [/^sandstone/, 0xd8c98a],
  [/^sand/, 0xe3d18a], [/^dirt/, 0x7a5230], [/^grass/, 0x5aa83f],
  [/^farmland/, 0x6e4a2f], [/^podzol/, 0x5a3a1f], [/^mycelium/, 0x6a5a7a],
  [/^snow/, 0xf0f4f8], [/^ice/, 0xa8d8ea], [/^leaves/, 0x3f7a3f],
  [/^glass/, 0xbfe3e8], [/^wool/, 0xe0e0e0], [/^carpet/, 0xe0e0e0],
  [/^bed$|_bed$/, 0xe0e0e0], [/^terracotta/, 0x9a6a5a], [/^concrete/, 0x8f8f8f],
  [/^brick/, 0x9a5a4a], [/^purpur/, 0x9a7a9f], [/^obsidian/, 0x23232e],
  [/^magma/, 0x8a3a1f], [/^glowstone/, 0xe8c98a], [/^slime/, 0x8fd86f],
  [/^honey/, 0xe8a82f], [/^pumpkin/, 0xd87f2f], [/^melon/, 0x7fc93f],
  [/^cake/, 0xf0e0d0], [/^shulker_box/, 0x9a5f8f], [/^candle/, 0xe8d8a8],
  [/^lantern/, 0xd4a017], [/^torch/, 0xd4a017], [/^soul_/, 0x3f8f9f],
  [/^chain/, 0x9aa0a6], [/^iron_/, 0xdadada], [/^gold_/, 0xe8c34a],
  [/^diamond/, 0x6fe3d8], [/^emerald/, 0x3fbf6f], [/^redstone/, 0xb91f1f],
  [/^lapis/, 0x2f4f9f], [/^coal/, 0x2f2f2f], [/^amethyst/, 0xa56fd8],
  [/^mushroom/, 0x8a5a3a], [/^sponge/, 0xc9c93f], [/^hay/, 0xd8b53f],
  [/^bone/, 0xe8e2d0]
];

/* Bright fallback palette — dark grays are deliberately absent so an
   unmapped block can never be invisible on the dark preview background. */
const FALLBACK_PALETTE = [
  0x94a3b8, 0x8b5e3c, 0x6b8e23, 0x3b82f6, 0xef4444, 0x10b981,
  0xf59e0b, 0x8b5cf6, 0xec4899, 0x14b8a6, 0x84cc16, 0xf97316,
  0x7c3aed, 0x0ea5e9
];

function blockColor(name) {
  const n = String(name || '').trim().toLowerCase().replace(/^minecraft:/, '');
  if (BLOCK_COLORS[n]) return BLOCK_COLORS[n];
  // Colour-named blocks: white_wool, blue_concrete, magenta_shulker_box…
  for (const c of Object.keys(NAMED_COLORS)) {
    if (n.startsWith(c + '_')) return NAMED_COLORS[c];
  }
  for (const [re, c] of BLOCK_FAMILY) {
    if (re.test(n)) return c;
  }
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

/* ---------- Guest mode ---------- */

function setAdminState() {
  for (const el of [els.upload, els.name, els.renameBtn, els.deleteBtn, els.startBtn, els.giveBtn, els.originBot]) {
    if (el) el.disabled = !isAdmin;
  }
  els.uploadHint.textContent = isAdmin ? 'Admins upload builds. Everyone can preview them.' : 'Only admins can upload builds.';
  els.name.placeholder = isAdmin ? 'e.g. Starter House v2' : 'Uploads are admin-only';
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

function prettyName(name) {
  return String(name || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
