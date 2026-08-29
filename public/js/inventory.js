'use strict';

/* ============================================================
   MineBot — Inventory page logic
   Live item grid with hover tooltips (enchantments, durability,
   shulker contents), drop-all, per-item drop, auto-drop and
   auto-eat controls. Admin-only actions; guests can view.
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
  invPlaceholder: $('inv-placeholder'),
  invPanel: $('inv-panel'),
  invCount: $('inv-count'),
  invSearch: $('inv-search'),
  invRarity: $('inv-rarity'),
  invMatchCount: $('inv-match-count'),
  invFilterClear: $('inv-filter-clear'),
  armorGrid: $('armor-grid'),
  offhandGrid: $('offhand-grid'),
  mainGrid: $('main-grid'),
  hotbarGrid: $('hotbar-grid'),
  selectedSlot: $('selected-slot'),
  healthBar: $('health-bar'),
  healthNum: $('health-num'),
  foodBar: $('food-bar'),
  foodNum: $('food-num'),
  saturationNum: $('saturation-num'),
  xpLevel: $('xp-level'),
  xpBar: $('xp-bar'),
  xpPoints: $('xp-points'),
  effectsList: $('effects-list'),
  effectsEmpty: $('effects-empty'),
  dropAllBtn: $('drop-all-btn'),
  autodropEnabled: $('autodrop-enabled'),
  autodropName: $('autodrop-name'),
  autodropSave: $('autodrop-save'),
  autoeatEnabled: $('autoeat-enabled'),
  autoeatThreshold: $('autoeat-threshold'),
  autoeatSave: $('autoeat-save'),
  autotoolEnabled: $('autotool-enabled'),
  autotoolSave: $('autotool-save'),
  autoarmorEnabled: $('autoarmor-enabled'),
  autoarmorSave: $('autoarmor-save'),
  guestNote: $('guest-note'),
  tooltip: $('tooltip'),
  tooltipBody: $('tooltip-body'),
  confirmModal: $('confirm-modal'),
  confirmBackdrop: $('confirm-backdrop'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  shulkerModal: $('shulker-modal'),
  shulkerBackdrop: $('shulker-backdrop'),
  shulkerClose: $('shulker-close'),
  shulkerTitle: $('shulker-title'),
  shulkerSub: $('shulker-sub'),
  shulkerGrid: $('shulker-grid'),
  shulkerEmpty: $('shulker-empty'),
  selectBar: $('select-bar'),
  selectName: $('select-name'),
  toasts: $('toasts')
};

const STATE_META = {
  stopped:      { text: 'STOPPED',      pill: '' },
  connecting:   { text: 'CONNECTING',   pill: 'connecting' },
  connected:    { text: 'IN SERVER',    pill: 'connected' },
  disconnected: { text: 'DISCONNECTED', pill: 'disconnected' },
  error:        { text: 'ERROR',        pill: 'error' }
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

// Item textures pinned to a stable release of InventivetalentDev's
// minecraft-assets repo (served via jsDelivr CDN). Modern versions use
// textures/item/ + block/, old versions (<1.13) use textures/items/ + blocks/.
const ICON_BASE = 'https://cdn.jsdelivr.net/gh/InventivetalentDev/minecraft-assets@1.21.4/assets/minecraft/textures';

let isAdmin = false;
let botConnected = false;
let snapshot = null;
let searchQuery = ''; // live search box text (lowercased on use)
let rarityFilter = ''; // '' | common | uncommon | rare | epic | legendary
let selectedSlot = null; // slot of the item the action bar is managing
let draggingSlot = null; // slot being dragged (drag & drop)
let openShulker = null;  // shulker box currently open in the viewer

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
    els.guestNote.classList.toggle('hidden', isAdmin);
    els.dropAllBtn.disabled = !isAdmin;
    els.autodropEnabled.disabled = !isAdmin;
    els.autodropName.disabled = !isAdmin;
    els.autodropSave.disabled = !isAdmin;
    els.autoeatEnabled.disabled = !isAdmin;
    els.autoeatThreshold.disabled = !isAdmin;
    els.autoeatSave.disabled = !isAdmin;
    els.autotoolEnabled.disabled = !isAdmin;
    els.autotoolSave.disabled = !isAdmin;
    els.autoarmorEnabled.disabled = !isAdmin;
    els.autoarmorSave.disabled = !isAdmin;
    els.autodropName.placeholder = isAdmin ? 'e.g. cobblestone' : 'Guests cannot change this';
    els.autoeatThreshold.placeholder = isAdmin ? '10' : '—';
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
  // Ask for a fresh snapshot on every (re)connect — returning to this tab
  // after a move/session must never show a stale or empty grid.
  socket.emit('inventory:get');
});
socket.on('disconnect', () => setConnPills(false));

socket.on('bot:state', (snap) => {
  const meta = STATE_META[snap.state] || STATE_META.stopped;
  els.statusPill.className = 'status-pill animate-fade-up ' + meta.pill;
  els.statusText.textContent = meta.text;
  els.targetLine.textContent = snap.config
    ? `${snap.config.botName} → ${snap.config.serverIp}:${snap.config.serverPort}`
    : 'No bot configured yet';
  botConnected = snap.state === 'connected';
  refreshActionState();
});

socket.on('inventory', (snap) => {
  snapshot = snap;
  if (!snap) {
    els.invPanel.classList.add('hidden');
    els.invPlaceholder.classList.remove('hidden');
    els.invCount.textContent = '0 items';
    els.invMatchCount.textContent = '';
    els.invMatchCount.classList.add('hidden');
    els.invFilterClear.classList.add('hidden');
    selectedSlot = null;
    updateSelectionBar();
    resetVitals();
    closeShulker(); // nothing to inspect when the bot has no inventory
    return;
  }
  renderInventory(snap);
  // Keep an open shulker viewer in sync with the latest snapshot (the
  // server re-broadcasts after every move/drop, so contents stay live).
  if (openShulker) {
    const fresh = findItemBySlot(openShulker.slot);
    if (fresh && fresh.isShulker) {
      openShulker = fresh;
      renderShulkerGrid();
    } else {
      closeShulker(); // item dropped or moved away while viewing
    }
  }
});

socket.on('inventory:settings', (s) => {
  els.autodropEnabled.checked = !!s.autoDropEnabled;
  els.autodropName.value = s.autoDropItem || '';
  els.autoeatEnabled.checked = !!s.autoEatEnabled;
  els.autoeatThreshold.value = s.autoEatThreshold;
  els.autotoolEnabled.checked = !!s.autoToolEnabled;
  els.autoarmorEnabled.checked = !!s.autoArmorEnabled;
});

/* ---------- Rendering ---------- */

function refreshActionState() {
  els.dropAllBtn.disabled = !(isAdmin && botConnected);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function iconUrls(item, snap) {
  const f = (snap && snap.folder) || 'item';
  const bf = (snap && snap.blockFolder) || (f === 'item' ? 'block' : 'blocks');
  return [`${ICON_BASE}/${f}/${item.name}.png`, `${ICON_BASE}/${bf}/${item.name}.png`];
}

/** Load an icon with a graceful chain: item tex → block tex → letter tile. */
function loadIcon(img, letterEl, urls) {
  let idx = 0;
  const next = () => {
    if (idx < urls.length) img.src = urls[idx++];
    else {
      img.style.display = 'none';
      if (letterEl) letterEl.style.display = 'grid';
    }
  };
  img.onload = () => {
    img.style.display = 'block';
    if (letterEl) letterEl.style.display = 'none';
  };
  img.onerror = next;
  next();
}

/** Rarity tier for an item name (drives slot tints + tooltip text color). */
function rarityTier(name) {
  const n = String(name || '');
  if (/(^|_)netherite_|elytra|trident|totem_of_undying|dragon_egg|nether_star|enchanted_golden_apple|beacon|conduit/.test(n)) return 'legendary';
  if (/diamond_|enchanted_/.test(n)) return 'epic';
  if (/(golden_|ender_|lapis_|emerald|quartz|dragon_|phantom_membrane|shulker_shell|experience_bottle|nautilus|heart_of_the_sea|soul_speed|swift_sneak|sculk|echo_shard)/.test(n)) return 'rare';
  if (/_ingot$|^diamond$|^emerald$|^gold$|redstone|^coal$|^iron_|netherite_scrap|^slime|^prismarine|^amethyst|^copper_/.test(n)) return 'uncommon';
  return 'common';
}

function rarityColor(name) {
  return {
    common: 'text-white',
    uncommon: 'text-yellow-200',
    rare: 'text-cyan-300',
    epic: 'text-purple-300',
    legendary: 'text-amber-300'
  }[rarityTier(name)] || 'text-white';
}

function makeSlot(item, snap, opts = {}) {
  const el = document.createElement('div');
  el.className =
    'inv-slot slot-rarity-' + rarityTier(item.name) + ' relative aspect-square rounded-lg border border-white/10 ' +
    'flex items-center justify-center transition-colors group overflow-hidden ' +
    (opts.interactive ? 'cursor-pointer hover:border-emerald-400/50 cursor-grab active:cursor-grabbing' : 'cursor-default');
  if (opts.slot != null) el.dataset.slot = String(opts.slot);
  if (opts.selected) {
    el.classList.add('ring-2', 'ring-emerald-400/70', 'shadow-lg', 'shadow-emerald-500/20');
  }
  if (opts.actionSelected) {
    el.classList.add('ring-2', 'ring-amber-400/80', 'shadow-lg', 'shadow-amber-500/20');
  }
  if (item.isShulker) el.classList.add('shulker-slot'); // clickable → contents viewer

  const inner = document.createElement('div');
  inner.className = 'relative w-full h-full flex items-center justify-center';

  const letter = document.createElement('span');
  letter.className = 'hidden text-xs font-bold text-slate-500';
  letter.textContent = (item.displayName || item.name || '?').charAt(0).toUpperCase();

  const img = document.createElement('img');
  img.className = 'w-8 h-8 sm:w-9 sm:h-9 image-pixelated object-contain';
  img.alt = item.displayName || item.name;
  img.loading = 'lazy';
  loadIcon(img, letter, iconUrls(item, snap));
  inner.append(img, letter);

  if (item.count > 1) {
    const badge = document.createElement('span');
    badge.className = 'absolute bottom-0.5 right-1 text-[10px] font-extrabold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]';
    badge.textContent = item.count;
    inner.appendChild(badge);
  }
  if (item.maxDurability && item.durability != null) {
    const pct = Math.max(0, Math.min(100, Math.round((item.durability / item.maxDurability) * 100)));
    const bar = document.createElement('div');
    bar.className = 'absolute bottom-0 inset-x-0 h-[3px] bg-slate-800';
    const fill = document.createElement('div');
    fill.className = 'h-full ' + (pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-amber-500' : 'bg-red-500');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    inner.appendChild(bar);
  }
  if (item.isShulker) {
    const tag = document.createElement('span');
    tag.className = 'absolute top-0.5 right-1 text-[9px] opacity-80';
    tag.innerHTML = mbIco('box');
    inner.appendChild(tag);
  }

  el.appendChild(inner);
  el.addEventListener('mouseenter', (e) => showTooltip(item, snap, e));
  el.addEventListener('mousemove', moveTooltip);
  el.addEventListener('mouseleave', hideTooltip);
  if (opts.interactive) wireSlotInteraction(el, item);
  return el;
}

/** Drag & drop (move/swap) + click-to-select for main/hotbar slots. */
function wireSlotInteraction(el, item) {
  const slot = Number(el.dataset.slot);
  if (!Number.isInteger(slot)) return;

  el.addEventListener('click', (e) => {
    if (draggingSlot !== null) return; // finishing a drag, not a click
    if (item.isShulker) openShulkerViewer(item); // 📦 — look inside first
    selectedSlot = selectedSlot === slot ? null : slot;
    updateSelectionBar();
  });

  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    draggingSlot = slot;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(slot));
    try { e.dataTransfer.setDragImage(el, 24, 24); } catch (_) { /* older browsers */ }
    el.classList.add('opacity-50', 'ring-2', 'ring-amber-400/70');
  });
  el.addEventListener('dragend', () => {
    draggingSlot = null;
    document.querySelectorAll('.inv-slot.drag-over').forEach((n) => n.classList.remove('drag-over'));
    el.classList.remove('opacity-50', 'ring-2', 'ring-amber-400/70');
  });
  el.addEventListener('dragover', (e) => {
    if (draggingSlot === null || draggingSlot === slot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    const from = draggingSlot;
    if (from === null || from === slot) return;
    draggingSlot = null;
    moveItem(from, slot);
  });
}

function renderInventory(snap) {
  els.invPlaceholder.classList.add('hidden');
  els.invPanel.classList.remove('hidden');

  const q = searchQuery.trim().toLowerCase();
  const rf = rarityFilter;
  const filtering = !!(q || rf);
  const matches = (item) => {
    if (!item) return false;
    if (q && !`${item.name} ${item.displayName || ''} ${item.customName || ''}`.toLowerCase().includes(q)) return false;
    if (rf && rarityTier(item.name) !== rf) return false;
    return true;
  };

  const total = snap.items.reduce((n, i) => n + (i.count || 1), 0);
  const shulkers = (snap.items || []).filter((i) => i.isShulker).length +
    (snap.armor || []).filter(Boolean).filter((i) => i.isShulker).length +
    (snap.offhand && snap.offhand.isShulker ? 1 : 0);
  els.invCount.innerHTML = `${total} item${total === 1 ? '' : 's'}` + (shulkers ? ` · ${mbIco('box')} ${shulkers}` : '');

  // Armor (slots 5-8) + offhand (45) are always rendered as drop targets
  // (even empty), so items can be dragged INTO and OUT of equipped slots.
  // NOTE: empty armor slots come through as `null` — filter them out before
  // indexing, otherwise `i.slot` on null throws and the WHOLE grid fails to
  // render (the classic "sections but no items" symptom).
  const armorBySlot = new Map((snap.armor || []).filter(Boolean).map((i) => [i.slot, i]));
  els.armorGrid.innerHTML = '';
  for (const s of [5, 6, 7, 8]) {
    const item = armorBySlot.get(s);
    els.armorGrid.appendChild(item
      ? makeSlot(item, snap, { slot: s, interactive: true, actionSelected: s === selectedSlot })
      : emptySlot(s, true));
  }

  els.offhandGrid.innerHTML = '';
  const off = snap.offhand;
  els.offhandGrid.appendChild(off
    ? makeSlot(off, snap, { slot: off.slot, interactive: true, actionSelected: off.slot === selectedSlot })
    : emptySlot(45, true));

  // Main 27 (slots 9–35) + hotbar 9 (slots 36–44). Mineflayer sorts by slot.
  const sorted = (snap.items || []).slice().sort((a, b) => a.slot - b.slot);
  const main = sorted.filter((i) => i.slot >= 9 && i.slot <= 35 && matches(i));
  const hotbar = sorted.filter((i) => i.slot >= 36 && i.slot <= 44 && matches(i));

  els.mainGrid.innerHTML = '';
  if (filtering) {
    // Compact results view: only matching items, no empty-slot fillers.
    main.forEach((item) => els.mainGrid.appendChild(makeSlot(item, snap, { slot: item.slot, interactive: true, actionSelected: item.slot === selectedSlot })));
  } else {
    for (let s = 9; s <= 35; s++) {
      const item = main.find((i) => i.slot === s);
      els.mainGrid.appendChild(item
        ? makeSlot(item, snap, { slot: item.slot, interactive: true, actionSelected: item.slot === selectedSlot })
        : emptySlot(s, true));
    }
  }

  els.hotbarGrid.innerHTML = '';
  const sel = snap.selectedSlot != null ? snap.selectedSlot : 0;
  els.selectedSlot.textContent = sel + 1;
  if (filtering) {
    hotbar.forEach((item) => els.hotbarGrid.appendChild(
      makeSlot(item, snap, { slot: item.slot, interactive: true, selected: item.slot - 36 === sel, actionSelected: item.slot === selectedSlot })
    ));
  } else {
    for (let s = 36; s <= 44; s++) {
      const item = hotbar.find((i) => i.slot === s);
      els.hotbarGrid.appendChild(item
        ? makeSlot(item, snap, { slot: item.slot, interactive: true, selected: s - 36 === sel, actionSelected: item.slot === selectedSlot })
        : emptySlot(s, true));
    }
  }

  updateSelectionBar();

  // Match counter + clear button visibility.
  if (filtering) {
    // Armor + offhand are always rendered (fixed slots), so they always count as shown.
    const shown = main.length + hotbar.length +
      (snap.armor || []).length +
      (snap.offhand ? 1 : 0);
    els.invMatchCount.textContent = `${shown} of ${total} shown`;
    els.invMatchCount.classList.remove('hidden');
    els.invFilterClear.classList.remove('hidden');
  } else {
    els.invMatchCount.textContent = '';
    els.invMatchCount.classList.add('hidden');
    els.invFilterClear.classList.add('hidden');
  }

  // Vitals
  const hp = Math.max(0, Math.min(20, snap.health));
  els.healthBar.style.width = (hp / 20) * 100 + '%';
  els.healthNum.textContent = snap.health + ' / 20';
  const food = Math.max(0, Math.min(20, snap.food));
  els.foodBar.style.width = (food / 20) * 100 + '%';
  els.foodNum.textContent = snap.food + ' / 20';
  els.saturationNum.textContent = snap.foodSaturation;

  // Experience
  if (snap.experience && snap.experience.level != null) {
    els.xpLevel.textContent = snap.experience.level;
    els.xpPoints.textContent = (snap.experience.points || 0) + ' XP';
    const prog = Math.max(0, Math.min(1, snap.experience.progress || 0));
    els.xpBar.style.width = prog * 100 + '%';
  } else {
    els.xpLevel.textContent = '—';
    els.xpPoints.textContent = '—';
    els.xpBar.style.width = '0%';
  }

  // Potion effects
  renderEffects(snap.effects || []);
}

function resetVitals() {
  els.xpLevel.textContent = '—';
  els.xpPoints.textContent = '—';
  els.xpBar.style.width = '0%';
  els.effectsList.innerHTML = '';
  els.effectsEmpty.classList.remove('hidden');
}

/** "90" -> "1m 30s", "600" -> "10m", "7200" -> "2h 0m". */
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

function renderEffects(effects) {
  els.effectsList.innerHTML = '';
  if (!effects.length) {
    els.effectsEmpty.classList.remove('hidden');
    return;
  }
  els.effectsEmpty.classList.add('hidden');
  for (const e of effects) {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 text-[11px]';
    const dot = document.createElement('span');
    dot.className = 'w-2 h-2 rounded-full shrink-0 ' + (e.good ? 'bg-emerald-400' : 'bg-red-400');
    const name = document.createElement('span');
    name.className = (e.good ? 'text-emerald-200/90' : 'text-red-200/90') + ' truncate';
    name.textContent = e.displayName + ' ' + (ROMAN[Math.min(e.amplifier, 12)] || e.amplifier);
    const time = document.createElement('span');
    time.className = 'ml-auto text-slate-500 shrink-0';
    time.textContent = fmtDuration(e.durationSeconds);
    row.append(dot, name, time);
    els.effectsList.appendChild(row);
  }
}

function emptySlot(slot, interactive) {
  const el = document.createElement('div');
  el.className =
    'inv-slot aspect-square rounded-lg border border-dashed border-white/10 bg-white/[0.015] ' +
    (interactive ? 'cursor-pointer' : '');
  if (slot != null) el.dataset.slot = String(slot);
  if (interactive) {
    el.addEventListener('dragover', (e) => {
      if (draggingSlot === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const from = draggingSlot;
      if (from === null || from === slot) return;
      draggingSlot = null;
      moveItem(from, slot);
    });
  }
  return el;
}

/* ---------- Tooltip ---------- */

function miniIcon(item, snap) {
  const urls = iconUrls(item, snap);
  return (
    `<img class="w-5 h-5 image-pixelated object-contain" alt="${escapeHtml(item.name)}" ` +
    `data-urls='${JSON.stringify(urls)}' data-i="0" onerror="__miniNext(this)">`
  );
}

// Global fallback used by the inline onerror in mini icons (tooltip content
// is innerHTML, so a global function is the reliable way to chain).
window.__miniNext = function (img) {
  try {
    const urls = JSON.parse(img.dataset.urls);
    let i = Number(img.dataset.i || 0) + 1;
    if (i < urls.length) {
      img.dataset.i = String(i);
      img.src = urls[i];
    } else {
      img.style.display = 'none';
    }
  } catch (_) {
    img.style.display = 'none';
  }
};

function tooltipHtml(item, snap, opts = {}) {
  const parts = [];
  parts.push(`<p class="text-sm font-extrabold ${rarityColor(item.name)}">${escapeHtml(item.displayName || item.name)}</p>`);
  if (item.customName) parts.push(`<p class="text-xs italic text-violet-300 mt-0.5">${escapeHtml(item.customName)}</p>`);
  parts.push(
    `<p class="text-[11px] text-slate-400 mt-0.5">${item.count} × ${escapeHtml(item.name)}` +
    (item.metadata ? ` · data ${item.metadata}` : '') + `</p>`
  );

  if (item.maxDurability && item.durability != null) {
    const pct = Math.round((item.durability / item.maxDurability) * 100);
    const color = pct > 50 ? 'bg-green-500' : pct > 20 ? 'bg-amber-500' : 'bg-red-500';
    const txt = pct > 50 ? 'text-green-400' : pct > 20 ? 'text-amber-400' : 'text-red-400';
    parts.push(
      `<div class="mt-2"><div class="flex justify-between text-[10px] mb-1">` +
      `<span class="text-slate-500">Durability</span><span class="${txt} font-bold">${item.durability}/${item.maxDurability}</span></div>` +
      `<div class="h-1.5 rounded-full bg-slate-800 overflow-hidden"><div class="h-full ${color}" style="width:${pct}%"></div></div></div>`
    );
  }

  if (item.enchants && item.enchants.length) {
    parts.push('<div class="mt-2 space-y-0.5">');
    for (const en of item.enchants) {
      const curse = /curse/i.test(en.name);
      parts.push(
        `<p class="text-[11px] ${curse ? 'text-red-400' : 'text-violet-300'}">` +
        `${escapeHtml(en.displayName || en.name)} ${ROMAN[Math.min(en.level, 12)] || en.level}</p>`
      );
    }
    parts.push('</div>');
  }

  if (item.lore && item.lore.length) {
    for (const l of item.lore) parts.push(`<p class="text-[11px] italic text-slate-500 mt-0.5">${escapeHtml(l)}</p>`);
  }
  if (item.foodRestores && item.foodPoints != null) {
    parts.push(`<p class="text-[11px] text-amber-300/80 mt-1">${mbIco('meat')} Food: +${item.foodPoints}</p>`);
  }

  if (item.isShulker) {
    const contents = item.shulker || [];
    parts.push('<div class="mt-2.5 pt-2.5 border-t border-white/10">');
    parts.push(`<p class="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">${mbIco('box')} Inside · ${contents.length} slot(s)</p>`);
    if (!contents.length) parts.push('<p class="text-[11px] text-slate-500">Empty shulker</p>');
    else {
      parts.push('<div class="space-y-1 max-h-36 overflow-y-auto pr-1">');
      for (const c of contents) {
        parts.push(
          `<div class="flex items-center gap-2">` +
          `<span class="w-5 h-5 shrink-0 rounded bg-slate-800/80 grid place-items-center overflow-hidden">${miniIcon(c, snap)}</span>` +
          `<span class="text-[11px] text-slate-300 truncate">${escapeHtml(c.displayName || c.name)}</span>` +
          `<span class="ml-auto text-[10px] text-slate-500 shrink-0">×${c.count}</span></div>`
        );
        if (c.enchants && c.enchants.length) {
          for (const en of c.enchants.slice(0, 3)) {
            parts.push(
              `<p class="text-[10px] text-violet-300/80 pl-7">↳ ${escapeHtml(en.displayName || en.name)} ` +
              `${ROMAN[Math.min(en.level, 12)] || en.level}</p>`
            );
          }
        }
      }
      parts.push('</div>');
    }
    parts.push(`<p class="text-[10px] text-purple-300/90 mt-1.5">${mbIco('hand-grab')} Click the box for a full-size viewer</p>`);
    parts.push('</div>');
  }

  // Per-item drop (main inventory only, admins, bot in server).
  // Content items viewed inside a shulker must never offer this — their slot
  // is 0–26, which would otherwise hit the range check below and drop the
  // WRONG stack (from the backpack, not the box).
  const droppable = !opts.inShulker && isAdmin && botConnected && item.slot >= 9 && item.slot <= 44;
  if (droppable) {
    parts.push(
      `<button id="tooltip-drop" type="button" class="pointer-events-auto w-full mt-2.5 text-[11px] font-bold text-red-300 ` +
      `bg-red-500/10 border border-red-400/25 rounded-lg py-1.5 hover:bg-red-500/20 transition-colors">` +
      `${mbIco('trash')} Drop ×${item.count}</button>`
    );
  }

  return parts.join('');
}

let tooltipItem = null;

function showTooltip(item, snap, ev, opts) {
  tooltipItem = item;
  els.tooltipBody.innerHTML = tooltipHtml(item, snap, opts);
  const btn = els.tooltipBody.querySelector('#tooltip-drop');
  if (btn) {
    btn.addEventListener('click', () => {
      hideTooltip();
      dropItem(item.name, item.count);
    });
  }
  els.tooltip.classList.remove('hidden');
  positionTooltip(ev);
}

function positionTooltip(ev) {
  const pad = 14;
  const tw = els.tooltip.offsetWidth || 280;
  const th = els.tooltip.offsetHeight || 160;
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + tw > window.innerWidth - 8) x = ev.clientX - tw - pad;
  if (y + th > window.innerHeight - 8) y = ev.clientY - th - pad;
  els.tooltip.style.left = Math.max(8, x) + 'px';
  els.tooltip.style.top = Math.max(8, y) + 'px';
}

function moveTooltip(ev) {
  if (!tooltipItem) return;
  positionTooltip(ev);
}

function hideTooltip() {
  tooltipItem = null;
  els.tooltip.classList.add('hidden');
}

/* ---------- Shulker box viewer ---------- */

/** Find an inventory item by slot across all sections (main, armor, offhand). */
function findItemBySlot(slot) {
  if (!snapshot || slot == null) return null;
  return (
    snapshot.items.find((i) => i.slot === slot) ||
    (snapshot.armor || []).filter(Boolean).find((i) => i.slot === slot) ||
    (snapshot.offhand && snapshot.offhand.slot === slot ? snapshot.offhand : null)
  );
}

function openShulkerViewer(item) {
  openShulker = item;
  renderShulkerGrid();
  els.shulkerModal.classList.remove('hidden');
  els.shulkerModal.classList.add('flex');
}

function closeShulker() {
  openShulker = null;
  els.shulkerModal.classList.add('hidden');
  els.shulkerModal.classList.remove('flex');
}

function renderShulkerGrid() {
  const item = openShulker;
  if (!item) return;

  const contents = item.shulker || [];
  const total = contents.reduce((n, c) => n + (c.count || 1), 0);
  els.shulkerTitle.textContent = item.displayName || item.name || 'Shulker Box';
  els.shulkerSub.textContent =
    `${contents.length} of 27 slots used · ${total} item${total === 1 ? '' : 's'}`;
  els.shulkerEmpty.classList.toggle('hidden', contents.length > 0);

  // Place contents at their real NBT slots (0–26). Items without a slot
  // (older data) are appended at the first free position instead of lumped
  // at the end, so the box reads left-to-right like the real game.
  const bySlot = new Map();
  let nextFree = 0;
  for (const c of contents) {
    let idx = Number(c.slot);
    if (!Number.isInteger(idx) || idx < 0 || idx > 26 || bySlot.has(idx)) {
      while (bySlot.has(nextFree)) nextFree++;
      idx = nextFree;
    }
    bySlot.set(idx, c);
    nextFree = idx + 1;
  }

  els.shulkerGrid.innerHTML = '';
  for (let s = 0; s < 27; s++) {
    const c = bySlot.get(s);
    els.shulkerGrid.appendChild(c ? makeContentSlot(c) : emptyContentSlot());
  }
}

/** A content cell inside the shulker viewer (icon + count + rarity tint). */
function makeContentSlot(item) {
  const el = document.createElement('div');
  el.className =
    'inv-slot slot-rarity-' + rarityTier(item.name) + ' relative aspect-square rounded-lg border border-white/10 ' +
    'flex items-center justify-center overflow-hidden group cursor-pointer hover:border-purple-400/50 transition-colors';

  const inner = document.createElement('div');
  inner.className = 'relative w-full h-full flex items-center justify-center';

  const letter = document.createElement('span');
  letter.className = 'hidden text-xs font-bold text-slate-500';
  letter.textContent = (item.displayName || item.name || '?').charAt(0).toUpperCase();

  const img = document.createElement('img');
  img.className = 'w-8 h-8 sm:w-9 sm:h-9 image-pixelated object-contain';
  img.alt = item.displayName || item.name;
  img.loading = 'lazy';
  loadIcon(img, letter, iconUrls(item, snapshot));
  inner.append(img, letter);

  if (item.count > 1) {
    const badge = document.createElement('span');
    badge.className = 'absolute bottom-0.5 right-1 text-[10px] font-extrabold text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.9)]';
    badge.textContent = item.count;
    inner.appendChild(badge);
  }

  el.appendChild(inner);
  el.addEventListener('mouseenter', (e) => showTooltip(item, snapshot, e, { inShulker: true }));
  el.addEventListener('mousemove', moveTooltip);
  el.addEventListener('mouseleave', hideTooltip);
  return el;
}

function emptyContentSlot() {
  const el = document.createElement('div');
  el.className = 'inv-slot aspect-square rounded-lg border border-dashed border-white/5 bg-white/[0.01]';
  return el;
}

els.shulkerClose.addEventListener('click', closeShulker);
els.shulkerBackdrop.addEventListener('click', closeShulker);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openShulker !== null) closeShulker();
});

/* ---------- Actions ---------- */

function dropItem(name, count) {
  socket.emit('inventory:drop', { name }, (res) => {
    if (res && res.ok) toast(`Dropped ${res.dropped} stack${res.dropped === 1 ? '' : 's'} of ${name}`, 'success');
    else toast(((res && res.errors) || ['Could not drop.'])[0], 'error');
  });
}

els.dropAllBtn.addEventListener('click', () => {
  els.confirmModal.classList.remove('hidden');
  els.confirmModal.classList.add('flex');
});

function closeConfirm() {
  els.confirmModal.classList.add('hidden');
  els.confirmModal.classList.remove('flex');
}
els.confirmNo.addEventListener('click', closeConfirm);
els.confirmBackdrop.addEventListener('click', closeConfirm);
els.confirmYes.addEventListener('click', () => {
  closeConfirm();
  socket.emit('inventory:dropAll', (res) => {
    if (res && res.ok) toast(`Dropped ${res.dropped} stack${res.dropped === 1 ? '' : 's'} — backpack empty.`, 'success');
    else toast(((res && res.errors) || ['Could not drop items.'])[0], 'error');
  });
});

function saveSettings(partial) {
  const payload = {
    autoDropEnabled: els.autodropEnabled.checked,
    autoDropItem: els.autodropName.value.trim(),
    autoEatEnabled: els.autoeatEnabled.checked,
    autoEatThreshold: Number(els.autoeatThreshold.value) || 10,
    autoToolEnabled: els.autotoolEnabled.checked,
    autoArmorEnabled: els.autoarmorEnabled.checked,
    ...partial
  };
  socket.emit('inventory:settings', payload, (res) => {
    if (res && res.ok) toast('Inventory settings saved.', 'success');
    else toast(((res && res.errors) || ['Could not save settings.'])[0], 'error');
  });
}

els.autodropSave.addEventListener('click', () => saveSettings({ autoDropEnabled: els.autodropEnabled.checked, autoDropItem: els.autodropName.value.trim() }));
els.autoeatSave.addEventListener('click', () => saveSettings({ autoEatEnabled: els.autoeatEnabled.checked, autoEatThreshold: Number(els.autoeatThreshold.value) || 10 }));
els.autotoolSave.addEventListener('click', () => saveSettings({ autoToolEnabled: els.autotoolEnabled.checked }));
els.autoarmorSave.addEventListener('click', () => saveSettings({ autoArmorEnabled: els.autoarmorEnabled.checked }));

/* ---------- Item selection + move/equip actions ---------- */

function updateSelectionBar() {
  if (selectedSlot == null || !snapshot || !isAdmin || !botConnected) {
    els.selectBar.classList.add('hidden');
    els.selectBar.classList.remove('flex');
    return;
  }
  const item = selectedItem();
  if (!item) {
    selectedSlot = null;
    els.selectBar.classList.add('hidden');
    els.selectBar.classList.remove('flex');
    return;
  }
  els.selectName.textContent = `${item.displayName || item.name} ×${item.count}`;
  // Equipped items (armor/offhand) can be held but not dropped — hide the drop buttons.
  const equipped = !(item.slot >= 9 && item.slot <= 44);
  els.selectBar.querySelectorAll('[data-act="drop1"], [data-act="dropall"]').forEach((b) => {
    b.classList.toggle('hidden', equipped);
  });
  els.selectBar.classList.remove('hidden');
  els.selectBar.classList.add('flex');
}

function moveItem(fromSlot, toSlot) {
  socket.emit('inventory:move', { fromSlot, toSlot }, (res) => {
    if (res && res.ok) {
      applyLocalMove(fromSlot, toSlot); // instant grid feedback
      toast('Item moved', 'success');
    } else {
      toast(((res && res.errors) || ['Could not move the item.'])[0], 'error');
    }
  });
}

/**
 * Optimistically apply a move/swap to the local snapshot so the grid updates
 * the moment the server confirms. The server re-broadcasts the settled
 * inventory a moment later (set_slot packets take a few hundred ms), so this
 * removes the visible lag when moving items into/out of armor slots.
 */
function applyLocalMove(fromSlot, toSlot) {
  if (!snapshot) return;
  const all = [];
  (snapshot.items || []).forEach((i) => all.push(i));
  (snapshot.armor || []).forEach((i) => i && all.push(i));
  if (snapshot.offhand) all.push(snapshot.offhand);
  const bySlot = new Map(all.map((i) => [i.slot, i]));
  const a = bySlot.get(fromSlot) || null;
  const b = bySlot.get(toSlot) || null;
  if (a) a.slot = toSlot;
  if (b) b.slot = fromSlot;
  // Rebuild the slot index AFTER the swap — the lookups below must see the
  // NEW slots, otherwise moved items silently vanish from the grid.
  const after = new Map(all.map((i) => [i.slot, i]));
  snapshot.items = all
    .filter((i) => i.slot >= 9 && i.slot <= 44)
    .sort((x, y) => x.slot - y.slot);
  snapshot.armor = [5, 6, 7, 8].map((s) => after.get(s) || null);
  snapshot.offhand = after.get(45) || null;
  renderInventory(snapshot);
  // Keep an open shulker viewer instant after an optimistic move too.
  if (openShulker) {
    const fresh = findItemBySlot(openShulker.slot);
    if (fresh && fresh.isShulker) {
      openShulker = fresh;
      renderShulkerGrid();
    } else {
      closeShulker();
    }
  }
}

function selectedItem() {
  if (!snapshot) return null;
  return (
    snapshot.items.find((i) => i.slot === selectedSlot) ||
    (snapshot.armor || []).filter(Boolean).find((i) => i.slot === selectedSlot) ||
    (snapshot.offhand && snapshot.offhand.slot === selectedSlot ? snapshot.offhand : null)
  );
}

function dropSelected(count) {
  const item = selectedItem();
  if (!item) return;
  const label = count === 1 ? '1 item' : 'everything';
  socket.emit('inventory:drop', { name: item.name, count }, (res) => {
    if (res && res.ok) toast(`Dropped ${label} of ${item.name}`, 'success');
    else toast(((res && res.errors) || ['Could not drop.'])[0], 'error');
  });
}

function equipSelected() {
  const item = selectedItem();
  if (!item) return;
  socket.emit('inventory:equip', { slot: item.slot }, (res) => {
    if (res && res.ok) toast(`${mbIco('hand-grab')} Now holding ${item.displayName || item.name}`, 'success');
    else toast(((res && res.errors) || ['Could not equip.'])[0], 'error');
  });
}

function hotbarSelected() {
  const item = selectedItem();
  if (!item) return;
  // First free hotbar slot (36–44).
  const used = new Set((snapshot.items || []).filter((i) => i.slot >= 36 && i.slot <= 44).map((i) => i.slot));
  let free = null;
  for (let s = 36; s <= 44; s++) {
    if (!used.has(s)) { free = s; break; }
  }
  if (free === null) {
    toast('Hotbar is full — drop something first.', 'error');
    return;
  }
  socket.emit('inventory:move', { fromSlot: item.slot, toSlot: free }, (res) => {
    if (res && res.ok) {
      applyLocalMove(item.slot, free);
      toast(`${mbIco('box')} Moved ${item.displayName || item.name} to hotbar slot ${free - 35}`, 'success');
    } else {
      toast(((res && res.errors) || ['Could not move to hotbar.'])[0], 'error');
    }
  });
}

els.selectBar.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const act = btn.dataset.act;
    if (act === 'close') { selectedSlot = null; updateSelectionBar(); }
    else if (act === 'drop1') dropSelected(1);
    else if (act === 'dropall') dropSelected(undefined);
    else if (act === 'hand') equipSelected();
    else if (act === 'hotbar') hotbarSelected();
  });
});

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
  }, 4200);
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

/* ---------- Search / filter ---------- */

function clearFilters() {
  els.invSearch.value = '';
  els.invRarity.value = '';
  searchQuery = '';
  rarityFilter = '';
  if (snapshot) renderInventory(snapshot);
}

els.invSearch.addEventListener('input', () => {
  searchQuery = els.invSearch.value;
  if (snapshot) renderInventory(snapshot);
});
els.invRarity.addEventListener('change', () => {
  rarityFilter = els.invRarity.value;
  if (snapshot) renderInventory(snapshot);
});
els.invFilterClear.addEventListener('click', clearFilters);

/* ---------- Boot ---------- */

refreshActionState();
