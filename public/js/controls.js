'use strict';

/* ============================================================
   MineBot — Controls page logic
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  enabled: $('follow-enabled'),
  player: $('follow-player'),
  mode: $('follow-mode'),
  radius: $('follow-radius'),
  saveBtn: $('follow-save'),
  saveHint: $('follow-save-hint'),
  stateBadge: $('follow-state-badge'),
  liveIcon: $('follow-live-icon'),
  liveTitle: $('follow-live-title'),
  liveSub: $('follow-live-sub'),
  stopNow: $('follow-stop-now'),
  guardEnabled: $('guard-enabled'),
  guardPlayer: $('guard-player'),
  guardMode: $('guard-mode'),
  guardRadius: $('guard-radius'),
  guardAttackRange: $('guard-attack-range'),
  guardHostile: $('guard-hostile'),
  guardPassive: $('guard-passive'),
  guardPlayers: $('guard-players'),
  guardSaveBtn: $('guard-save'),
  guardSaveHint: $('guard-save-hint'),
  guardLiveIcon: $('guard-live-icon'),
  guardLiveTitle: $('guard-live-title'),
  guardLiveSub: $('guard-live-sub'),
  guardStopNow: $('guard-stop-now'),
  sleepBtn: $('sleep-btn'),
  wakeBtn: $('wake-btn'),
  sleepStatus: $('sleep-status'),
  lookEnabled: $('look-enabled'),
  lookSaveBtn: $('look-save'),
  mineEnabled: $('mine-enabled'),
  mineMode: $('mine-mode'),
  mineSaveBtn: $('mine-save'),
  mineSaveHint: $('mine-save-hint'),
  mineStopNow: $('mine-stop-now'),
  mineLiveIcon: $('mine-live-icon'),
  mineLiveTitle: $('mine-live-title'),
  mineLiveSub: $('mine-live-sub'),
  mineBlockInput: $('mine-block-input'),
  mineBlockBtn: $('mine-block-btn'),
  mineBlockStatus: $('mine-block-status'),
  userBadge: $('user-badge'),
  toasts: $('toasts'),
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  connPillSidebar: $('conn-pill-sidebar'),
  connPillMobile: $('conn-pill-mobile')
};

let me = null;
let current = { enabled: false, player: '', mode: 'survival', radius: 5 };
let currentGuard = { enabled: false, player: '', mode: 'survival', radius: 5, attackRange: 8, hostile: true, passive: true, players: false };
let socket = null;
let currentLook = { enabled: false };
let currentMining = { enabled: false, mode: 'straight' };

/* ---------- Auth ---------- */

async function init() {
  const res = await fetch('/api/auth/me');
  const data = await res.json();
  if (!data.ok) {
    window.location.replace('/login.html');
    return;
  }
  me = data.user;
  els.userBadge.innerHTML = mbIco('user') + ` ${me.username} · ${me.role === 'admin' ? 'Admin' : 'Guest'}`;

  // Guests can view + stop follow/guard + run one-shot actions but not save
  // config changes (mining settings included).
  if (me.role !== 'admin') {
    for (const b of [els.saveBtn, els.guardSaveBtn, els.lookSaveBtn, els.mineSaveBtn]) {
      b.disabled = true;
      b.title = 'Admin permission required to save changes.';
    }
    for (const input of [
      els.player, els.mode, els.radius, els.enabled,
      els.guardPlayer, els.guardMode, els.guardRadius, els.guardAttackRange,
      els.guardHostile, els.guardPassive, els.guardPlayers, els.guardEnabled,
      els.lookEnabled,
      els.mineEnabled, els.mineMode
    ]) {
      input.disabled = true;
    }
    els.saveHint.textContent = 'Read-only — an admin can save follow settings.';
    els.guardSaveHint.textContent = 'Read-only — an admin can save guard settings.';
    els.mineSaveHint.textContent = 'Read-only — an admin can save mining settings.';
  }

  connectSocket();
}

/* ---------- Socket ---------- */

function connectSocket() {
  socket = io({ path: '/socket.io' });

  socket.on('connect', () => {
    setConnPill(true);
  });
  socket.on('disconnect', () => setConnPill(false));
  socket.on('connect_error', () => setConnPill(false));

  socket.on('controls:config', (d) => {
    if (d && d.ok && d.settings) applySettings(d.settings);
    if (d && d.guard) applyGuardSettings(d.guard);
    if (d && d.look) applyLookSettings(d.look);
    if (d && d.mining) applyMiningSettings(d.mining);
  });
  socket.on('controls:updated', (d) => {
    if (d && d.settings) applySettings(d.settings);
  });
  socket.on('controls:guard-updated', (d) => {
    if (d && d.guard) applyGuardSettings(d.guard);
  });
  socket.on('controls:look-updated', (d) => {
    if (d && d.look) applyLookSettings(d.look);
  });
  socket.on('controls:status', (s) => renderStatus(s));
  socket.on('controls:guard-status', (s) => renderGuardStatus(s));
  socket.on('controls:mining-status', (s) => renderMiningStatus(s));
  socket.on('controls:mining-updated', (d) => {
    if (d && d.mining) applyMiningSettings(d.mining);
  });

  // Ask for the saved config (in case the page opened before socket connect).
  socket.emit('controls:get', (d) => {
    if (d && d.ok && d.settings) applySettings(d.settings);
    if (d && d.guard) applyGuardSettings(d.guard);
    if (d && d.look) applyLookSettings(d.look);
    if (d && d.mining) applyMiningSettings(d.mining);
  });

  socket.on('bot:state', (snap) => {
    const state = snap && snap.state ? snap.state : 'stopped';
    els.stateBadge.innerHTML =
      state === 'connected' ? mbIco('circle-check') + ' Bot connected' : state === 'connecting' ? mbIco('refresh') + ' Connecting…' : mbIco('plug') + ' Bot offline';
    els.stateBadge.className =
      'badge ' + (state === 'connected' ? 'badge-emerald' : state === 'connecting' ? 'badge-amber' : 'badge-slate') + ' shrink-0';
  });
}

function setConnPill(up) {
  const cls = up ? 'text-emerald-400' : 'text-slate-500';
  const txt = up ? '● Online' : '○ Offline';
  els.connPillSidebar.className = 'text-xs font-bold ' + cls;
  els.connPillSidebar.textContent = txt;
  els.connPillMobile.className = 'text-xs font-bold ' + cls;
  els.connPillMobile.textContent = up ? '●' : '○';
}

/* ---------- Settings form ---------- */

function applySettings(s) {
  current = {
    enabled: !!s.enabled,
    player: String(s.player || ''),
    mode: s.mode === 'op' ? 'op' : 'survival',
    radius: Number(s.radius) || 5
  };
  els.enabled.checked = current.enabled;
  els.player.value = current.player;
  els.mode.value = current.mode;
  els.radius.value = current.radius;
  if (!current.enabled) {
    renderStatus({ status: 'off', enabled: false, player: current.player });
  }
}

function collect() {
  return {
    enabled: els.enabled.checked,
    player: els.player.value.trim(),
    mode: els.mode.value,
    radius: Number(els.radius.value)
  };
}

els.saveBtn.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  socket.emit('controls:save', collect(), (res) => {
    if (res && res.ok) {
      toast('Follow settings saved', 'success');
      if (res.settings) applySettings(res.settings);
    } else {
      const errs = (res && res.errors) || ['Could not save the follow settings.'];
      toast(errs[0], 'error');
    }
  });
});

// Stop following now: turns the toggle off (doesn't erase the saved player).
els.stopNow.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  els.enabled.checked = false;
  socket.emit('controls:save', collect(), (res) => {
    if (res && res.ok) {
      toast('Follow stopped', 'success');
      if (res.settings) applySettings(res.settings);
    } else {
      const errs = (res && res.errors) || ['Could not stop follow.'];
      toast(errs[0], 'error');
      els.enabled.checked = current.enabled;
    }
  });
});

/* ---------- Guard settings form ---------- */

function applyGuardSettings(g) {
  currentGuard = {
    enabled: !!g.enabled,
    player: String(g.player || ''),
    mode: g.mode === 'op' ? 'op' : 'survival',
    radius: Number(g.radius) || 5,
    attackRange: Number(g.attackRange) || 8,
    hostile: g.hostile !== false,
    passive: g.passive !== false,
    players: !!g.players
  };
  els.guardEnabled.checked = currentGuard.enabled;
  els.guardPlayer.value = currentGuard.player;
  els.guardMode.value = currentGuard.mode;
  els.guardRadius.value = currentGuard.radius;
  els.guardAttackRange.value = currentGuard.attackRange;
  els.guardHostile.checked = currentGuard.hostile;
  els.guardPassive.checked = currentGuard.passive;
  els.guardPlayers.checked = currentGuard.players;
  if (!currentGuard.enabled) {
    renderGuardStatus({ status: 'off', enabled: false, player: currentGuard.player });
  }
}

function collectGuard() {
  return {
    enabled: els.guardEnabled.checked,
    player: els.guardPlayer.value.trim(),
    mode: els.guardMode.value,
    radius: Number(els.guardRadius.value),
    attackRange: Number(els.guardAttackRange.value),
    hostile: els.guardHostile.checked,
    passive: els.guardPassive.checked,
    players: els.guardPlayers.checked
  };
}

els.guardSaveBtn.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  socket.emit('controls:guard-save', collectGuard(), (res) => {
    if (res && res.ok) {
      toast('Guard settings saved', 'success');
      if (res.guard) applyGuardSettings(res.guard);
    } else {
      const errs = (res && res.errors) || ['Could not save the guard settings.'];
      toast(errs[0], 'error');
    }
  });
});

// Stop guarding now: turns the toggle off (doesn't erase the saved player).
els.guardStopNow.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  els.guardEnabled.checked = false;
  socket.emit('controls:guard-save', collectGuard(), (res) => {
    if (res && res.ok) {
      toast('Guard stopped', 'success');
      if (res.guard) applyGuardSettings(res.guard);
    } else {
      const errs = (res && res.errors) || ['Could not stop guard.'];
      toast(errs[0], 'error');
      els.guardEnabled.checked = currentGuard.enabled;
    }
  });
});

/* ---------- Look at players ---------- */

function applyLookSettings(l) {
  currentLook = { enabled: !!l.enabled };
  els.lookEnabled.checked = currentLook.enabled;
}

els.lookSaveBtn.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  socket.emit('controls:look-save', { enabled: els.lookEnabled.checked }, (res) => {
    if (res && res.ok) {
      toast(els.lookEnabled.checked ? 'Look at players enabled' : 'Look at players disabled', 'success');
      if (res.look) applyLookSettings(res.look);
    } else {
      const errs = (res && res.errors) || ['Could not save the look setting.'];
      toast(errs[0], 'error');
      els.lookEnabled.checked = currentLook.enabled;
    }
  });
});

/* ---------- Mining settings form ---------- */

function applyMiningSettings(m) {
  currentMining = {
    enabled: !!m.enabled,
    mode: m.mode === 'stair' ? 'stair' : 'straight'
  };
  els.mineEnabled.checked = currentMining.enabled;
  els.mineMode.value = currentMining.mode;
  if (!currentMining.enabled) {
    renderMiningStatus({ status: 'off', enabled: false, mode: currentMining.mode });
  }
}

function collectMining() {
  return {
    enabled: els.mineEnabled.checked,
    mode: els.mineMode.value
  };
}

els.mineSaveBtn.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  socket.emit('controls:mining-save', collectMining(), (res) => {
    if (res && res.ok) {
      toast(els.mineEnabled.checked ? `Mining started (${els.mineMode.value})` : 'Mining stopped', 'success');
      if (res.mining) applyMiningSettings(res.mining);
    } else {
      const errs = (res && res.errors) || ['Could not save the mining settings.'];
      toast(errs[0], 'error');
    }
  });
});

// Stop mining now: turns the toggle off (doesn't erase the saved shape).
els.mineStopNow.addEventListener('click', () => {
  if (me.role !== 'admin') return toast('Admin permission required.', 'error');
  els.mineEnabled.checked = false;
  socket.emit('controls:mining-save', collectMining(), (res) => {
    if (res && res.ok) {
      toast('Mining stopped', 'success');
      if (res.mining) applyMiningSettings(res.mining);
    } else {
      const errs = (res && res.errors) || ['Could not stop mining.'];
      toast(errs[0], 'error');
      els.mineEnabled.checked = currentMining.enabled;
    }
  });
});

/* ---------- Mine a specific block (one-shot) ---------- */

els.mineBlockBtn.addEventListener('click', async () => {
  const block = els.mineBlockInput.value.trim().toLowerCase();
  if (!block) {
    toast('Type a block name first, e.g. diamond_ore.', 'error');
    return;
  }
  els.mineBlockBtn.disabled = true;
  els.mineBlockBtn.innerHTML = mbIco('pick') + ' Mining…';
  els.mineBlockStatus.textContent = `Looking for the nearest ${block} around the bot…`;
  els.mineBlockStatus.className = 'text-xs text-amber-300/90 leading-relaxed';
  try {
    const res = await new Promise((resolve) => {
      socket.emit('controls:mine-block', { block }, resolve);
    });
    if (res && res.ok) {
      toast(`Mined ${res.block}`, 'success');
      els.mineBlockStatus.innerHTML = `${mbIco('circle-check')} Mined a ${res.block} within 5 blocks of the bot.`;
      els.mineBlockStatus.className = 'text-xs text-emerald-300/90 leading-relaxed';
    } else {
      const errs = (res && res.errors) || ['Could not mine that block.'];
      toast(errs[0], 'error');
      els.mineBlockStatus.innerHTML = mbIco('alert-triangle') + ' ' + errs[0];
      els.mineBlockStatus.className = 'text-xs text-red-300/90 leading-relaxed';
    }
  } catch (err) {
    toast(err && err.message ? err.message : 'Socket error', 'error');
  } finally {
    els.mineBlockBtn.disabled = false;
    els.mineBlockBtn.innerHTML = mbIco('pick') + ' Mine it now';
  }
});

/* ---------- Mining live status ---------- */

function renderMiningStatus(s) {
  if (!s) return;
  const st = s.status || 'off';
  const mode = s.mode || currentMining.mode;
  const blocks = typeof s.blocks === 'number' ? s.blocks : 0;
  const shape = mode === 'stair' ? 'staircase' : 'straight';

  switch (st) {
    case 'mining':
      els.mineLiveIcon.innerHTML = mbIco('pick');
      els.mineLiveTitle.textContent = `Mining ${shape}${blocks ? ` — ${blocks} blocks broken` : ''}`;
      els.mineLiveSub.textContent =
        mode === 'stair'
          ? 'Digging the wall and the step below, descending one block per step.'
          : 'Digging the wall at body height and walking forward — a level 1×2 tunnel.';
      els.mineLiveTitle.className = 'text-sm font-bold text-amber-300';
      break;
    case 'waiting':
      els.mineLiveIcon.innerHTML = mbIco('clock');
      els.mineLiveTitle.textContent = 'Mining armed — waiting for the bot';
      els.mineLiveSub.textContent = s.reason || 'Start the bot to begin mining.';
      els.mineLiveTitle.className = 'text-sm font-bold text-amber-300';
      break;
    default:
      els.mineLiveIcon.innerHTML = mbIco('moon');
      els.mineLiveTitle.textContent = 'Mining is off';
      els.mineLiveSub.textContent = 'Enable it above and save to start digging. Bedrock is never mined.';
      els.mineLiveTitle.className = 'text-sm font-bold text-white';
  }
}

/* ---------- Sleep / wake ---------- */

async function runSleepAction(kind) {
  const btn = kind === 'sleep' ? els.sleepBtn : els.wakeBtn;
  const other = kind === 'sleep' ? els.wakeBtn : els.sleepBtn;
  btn.disabled = true;
  btn.innerHTML = kind === 'sleep' ? mbIco('moon') + ' Finding bed…' : mbIco('sun') + ' Waking…';
  other.disabled = true;
  els.sleepStatus.textContent =
    kind === 'sleep'
      ? 'Scanning for the nearest bed within 48 blocks and walking over…'
      : 'Telling the bot to get up…';
  els.sleepStatus.className = 'text-xs text-amber-300/90 leading-relaxed';
  try {
    const res = await new Promise((resolve) => {
      socket.emit(kind === 'sleep' ? 'controls:sleep' : 'controls:wake', {}, resolve);
    });
    if (res && res.ok) {
      toast(res.message || (kind === 'sleep' ? 'Bot is sleeping' : 'Bot woke up'), 'success');
      els.sleepStatus.textContent = res.message || '';
      els.sleepStatus.className = 'text-xs text-emerald-300/90 leading-relaxed';
    } else {
      const errs = (res && res.errors) || [kind === 'sleep' ? 'Could not sleep.' : 'Could not wake the bot.'];
      toast(errs[0], 'error');
      els.sleepStatus.innerHTML = mbIco('alert-triangle') + ' ' + errs[0];
      els.sleepStatus.className = 'text-xs text-red-300/90 leading-relaxed';
    }
  } catch (err) {
    toast(err && err.message ? err.message : 'Socket error', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = kind === 'sleep' ? 'Sleep' : 'Wake';
    other.disabled = false;
  }
}

els.sleepBtn.addEventListener('click', () => runSleepAction('sleep'));
els.wakeBtn.addEventListener('click', () => runSleepAction('wake'));

/* ---------- Guard live status ---------- */

function renderGuardStatus(s) {
  if (!s) return;
  const st = s.status || 'off';
  const player = s.player || currentGuard.player;
  const threat = s.threat || '';
  const dist = typeof s.distance === 'number' ? `${Math.round(s.distance)} blocks away` : '';

  switch (st) {
    case 'scanning':
      els.guardLiveIcon.innerHTML = mbIco('search');
      els.guardLiveTitle.textContent = `Looking for ${player || 'player'}…`;
      els.guardLiveSub.textContent = 'Scanning the server every second for the player and nearby threats.';
      els.guardLiveTitle.className = 'text-sm font-bold text-amber-300';
      break;
    case 'following':
      els.guardLiveIcon.innerHTML = mbIco('walk');
      els.guardLiveTitle.textContent = `Guarding ${player}${dist ? ` — ${dist}` : ''}`;
      els.guardLiveSub.textContent =
        s.mode === 'op' ? 'Operator mode — teleporting to keep up.' : 'Survival mode — walking to keep up.';
      els.guardLiveTitle.className = 'text-sm font-bold text-emerald-300';
      break;
    case 'fighting':
      els.guardLiveIcon.innerHTML = mbIco('swords');
      els.guardLiveTitle.textContent = `Fighting ${threat || 'a threat'}!`;
      els.guardLiveSub.textContent = 'Defending the player — will return to following once it is dealt with.';
      els.guardLiveTitle.className = 'text-sm font-bold text-red-300';
      break;
    case 'idle':
      els.guardLiveIcon.innerHTML = mbIco('circle-check');
      els.guardLiveTitle.textContent = `In range — ${player} is within ${currentGuard.radius || s.radius || 5} blocks`;
      els.guardLiveSub.textContent = 'Standing by. Moving + attacking resumes when they leave the radius or a threat appears.';
      els.guardLiveTitle.className = 'text-sm font-bold text-emerald-300';
      break;
    case 'waiting':
      els.guardLiveIcon.innerHTML = mbIco('clock');
      els.guardLiveTitle.textContent = 'Guard armed — waiting for the bot';
      els.guardLiveSub.textContent = s.reason || 'Start the bot to begin guarding.';
      els.guardLiveTitle.className = 'text-sm font-bold text-amber-300';
      break;
    default:
      els.guardLiveIcon.innerHTML = mbIco('moon');
      els.guardLiveTitle.textContent = 'Guard is off';
      els.guardLiveSub.textContent = 'Enable it above and save to start guarding a player.';
      els.guardLiveTitle.className = 'text-sm font-bold text-white';
  }
}

/* ---------- Live status ---------- */

function renderStatus(s) {
  if (!s) return;
  const st = s.status || 'off';
  const player = s.player || current.player;
  const dist = typeof s.distance === 'number' ? `${Math.round(s.distance)} blocks away` : '';

  switch (st) {
    case 'scanning':
      els.liveIcon.innerHTML = mbIco('search');
      els.liveTitle.textContent = `Looking for ${player || 'player'}…`;
      els.liveSub.textContent = 'Scanning the server every second until they appear.';
      els.liveTitle.className = 'text-sm font-bold text-amber-300';
      break;
    case 'following':
      els.liveIcon.innerHTML = mbIco('walk');
      els.liveTitle.textContent = `Following ${player}${dist ? ` — ${dist}` : ''}`;
      els.liveSub.textContent =
        s.mode === 'op' ? 'Operator mode — teleporting as they move out of range.' : 'Survival mode — walking to keep up.';
      els.liveTitle.className = 'text-sm font-bold text-emerald-300';
      break;
    case 'idle':
      els.liveIcon.innerHTML = mbIco('circle-check');
      els.liveTitle.textContent = `In range — ${player} is within ${current.radius || s.radius || 5} blocks`;
      els.liveSub.textContent = 'Bot is standing by. It will move again when they leave the radius.';
      els.liveTitle.className = 'text-sm font-bold text-emerald-300';
      break;
    case 'waiting':
      els.liveIcon.innerHTML = mbIco('clock');
      els.liveTitle.textContent = 'Follow armed — waiting for the bot';
      els.liveSub.textContent = s.reason || 'Start the bot to begin following.';
      els.liveTitle.className = 'text-sm font-bold text-amber-300';
      break;
    default:
      els.liveIcon.innerHTML = mbIco('moon');
      els.liveTitle.textContent = 'Follow is off';
      els.liveSub.textContent = 'Enable it above and save to start following a player.';
      els.liveTitle.className = 'text-sm font-bold text-white';
  }
}

/* ---------- Sidebar / logout (shared behaviour) ---------- */

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

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.replace('/login.html');
});

/* ---------- Toasts ---------- */

function toast(message, type = 'info') {
  const icon = type === 'success' ? mbIco('circle-check') : type === 'error' ? mbIco('circle-x') : mbIco('info-circle');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="select-none">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- Boot ---------- */

init();
