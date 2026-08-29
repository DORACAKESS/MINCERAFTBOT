'use strict';

/* ============================================================
   viewer-patch.js — MineBot 3D viewer enhancements
   ------------------------------------------------------------
   Loaded AFTER the patched prismarine-viewer bundle. Uses the
   internals the bundle exposes on window.__mb:
       __mb.v  = Viewer  (scene, camera, world, entities…)
       __mb.c  = () => OrbitControls (live; null in first-person)
       __mb.s  = the viewer socket
       __mb.r  = WebGLRenderer
       __mb.T  = THREE

   Adds:
    - colour-coded markers for the bot (emerald), players (blue),
      hostile mobs (red) and passive mobs (green)
    - "Move to bot"  — teleport the camera to the bot
    - "Follow bot"   — keep the camera above the bot as it moves
    - "Locate"       — tall coloured sky-beams + sky dots for every
                       tracked entity (find anything from anywhere)
    - performance    — cap the pixel ratio, trim the meshing workers
   ============================================================ */

(() => {
  // icons.js is loaded before this script on the viewer page; if it's ever
  // missing, degrade to empty icons instead of crashing the 3D view.
  if (typeof window.mbIco !== 'function') window.mbIco = () => '';

  const $ = (id) => document.getElementById(id);

  const COLORS = {
    bot: 0x34d399,     // emerald
    player: 0x60a5fa,  // blue
    hostile: 0xef4444, // red
    passive: 0x4ade80  // green
  };

  const HOSTILE_RE =
    /(zombie|zombie_villager|drowned|husk|skeleton|stray|wither_skeleton|creeper|spider|cave_spider|enderman|endermite|silverfish|witch|blaze|ghast|magma_cube|slime|phantom|shulker|guardian|elder_guardian|vex|pillager|vindicator|evoker|illusioner|ravager|piglin|piglin_brute|hoglin|zoglin|warden|wither|ender_dragon|giant|breeze|bogged)/;

  const BEAM_H = 46; // height of the locate beams
  const MAX_MARKERS = 120;

  const state = {
    mb: null,
    ready: false,
    botPos: null,
    botYaw: 0,
    entities: new Map(), // id -> { kind, group, beam, dot, ring }
    follow: false,
    followOffset: null,
    locate: true,
    mats: null, // shared materials per colour
    dots: null, // shared sky-dot sprites per colour
    version: null,
    // WASD camera controls (captured here when the iframe is focused, or
    // forwarded from the parent map page via postMessage otherwise).
    wasd: { w: false, a: false, s: false, d: false, shift: false },
    lastTick: 0
  };

  function classify(entity) {
    if (entity.username !== undefined) return 'player';
    const n = String(entity.name || '');
    if (HOSTILE_RE.test(n)) return 'hostile';
    if (n === 'player' || n === 'human') return 'player';
    return 'passive';
  }

  /* ---------- Shared assets ---------- */

  function dotTexture(color) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const x = c.getContext('2d');
    x.clearRect(0, 0, 64, 64);
    const grad = x.createRadialGradient(32, 32, 3, 32, 32, 30);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.4, '#' + color.toString(16).padStart(6, '0'));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = grad;
    x.beginPath();
    x.arc(32, 32, 30, 0, Math.PI * 2);
    x.fill();
    const t = new state.mb.T.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }

  function buildShared() {
    const T = state.mb.T;
    const mats = {};
    const dots = {};
    for (const kind of Object.keys(COLORS)) {
      const color = COLORS[kind];
      mats[kind] = new T.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.32,
        depthWrite: false
      });
      dots[kind] = new T.SpriteMaterial({
        map: dotTexture(color),
        transparent: true,
        depthWrite: false
      });
    }
    state.mats = mats;
    state.dots = dots;
  }

  /* ---------- Markers ---------- */

  function makeMarker(kind, isBot) {
    const T = state.mb.T;
    const group = new T.Group();

    // Tall locate beam (base at y=0, top at BEAM_H)
    const beamGeo = new T.CylinderGeometry(0.16, 0.22, 1, 6);
    beamGeo.translate(0, 0.5, 0);
    const beam = new T.Mesh(beamGeo, state.mats[kind]);
    beam.scale.y = BEAM_H;
    beam.visible = state.locate;
    group.add(beam);

    // Sky dot floating above the beam
    const dot = new T.Sprite(state.dots[kind]);
    dot.scale.set(1.6, 1.6, 1);
    dot.position.y = BEAM_H + 2;
    dot.visible = state.locate;
    group.add(dot);

    // Ground ring + pulsing glow for the bot only
    let ring = null;
    let glow = null;
    if (isBot) {
      const ringGeo = new T.RingGeometry(1.5, 1.85, 28);
      ringGeo.rotateX(-Math.PI / 2);
      ring = new T.Mesh(
        ringGeo,
        new T.MeshBasicMaterial({
          color: COLORS.bot,
          transparent: true,
          opacity: 0.8,
          side: T.DoubleSide,
          depthWrite: false
        })
      );
      ring.position.y = 0.12;
      group.add(ring);

      const glowGeo = new T.RingGeometry(0.9, 1.3, 24);
      glowGeo.rotateX(-Math.PI / 2);
      glow = new T.Mesh(
        glowGeo,
        new T.MeshBasicMaterial({
          color: COLORS.bot,
          transparent: true,
          opacity: 0.25,
          side: T.DoubleSide,
          depthWrite: false
        })
      );
      glow.position.y = 0.1;
      group.add(glow);
    }

    state.mb.v.scene.add(group);
    return { group, beam, dot, ring, glow };
  }

  /** Small canvas-text sprite: the entity's name floating over the marker. */
  function makeNameLabel(text, height) {
    const T = state.mb.T;
    const label = String(text || '').slice(0, 24);
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    const font = 'bold 26px system-ui, sans-serif';
    ctx.font = font;
    const w = Math.max(36, Math.ceil(ctx.measureText(label).width) + 22);
    c.width = w;
    c.height = 40;
    ctx.font = font;
    // Rounded pill behind the text so it reads against any terrain.
    ctx.fillStyle = 'rgba(8,12,20,0.72)';
    const r = 9;
    ctx.beginPath();
    ctx.moveTo(r, 3);
    ctx.arcTo(w - 3, 3, w - 3, 37, r);
    ctx.arcTo(w - 3, 37, 3, 37, r);
    ctx.arcTo(3, 37, 3, 3, r);
    ctx.arcTo(3, 3, w - 3, 3, r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, w / 2, 21);
    const tex = new T.CanvasTexture(c);
    tex.needsUpdate = true;
    const sprite = new T.Sprite(
      new T.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
    );
    sprite.scale.set(2.9, 0.62, 1);
    sprite.position.y = (Number(height) || 1) + 1.2;
    return sprite;
  }

  function upsertMarker(id, pos, kind, isBot, ent) {
    if (state.entities.size >= MAX_MARKERS && !state.entities.has(id)) return;
    let m = state.entities.get(id);
    if (!m) {
      m = { kind, ...makeMarker(kind, isBot) };
      // Name label above the marker (players show their username, mobs their
      // name) — so an entity without a 3D model never looks like a mystery
      // crafting-table block again.
      const labelName = ent && (ent.username || ent.name);
      if (labelName && !isBot) {
        m.label = makeNameLabel(labelName, ent.height);
        m.group.add(m.label);
      }
      state.entities.set(id, m);
    } else if (!m.label && ent && !isBot && (ent.username || ent.name)) {
      // First sighting was a position-only update — add the label now that
      // we have a name.
      m.label = makeNameLabel(ent.username || ent.name, ent.height);
      m.group.add(m.label);
    }
    m.group.position.set(pos.x, pos.y, pos.z);
  }

  function removeMarker(id) {
    const m = state.entities.get(id);
    if (!m) return;
    state.mb.v.scene.remove(m.group);
    state.entities.delete(id);
  }

  function clearMarkers() {
    for (const id of [...state.entities.keys()]) removeMarker(id);
  }

  function applyLocate() {
    for (const m of state.entities.values()) {
      m.beam.visible = state.locate;
      m.dot.visible = state.locate;
    }
  }

  /* ---------- Camera ---------- */

  function moveToBot() {
    if (!state.mb || !state.botPos) return;
    const p = state.botPos;
    const ctl = state.mb.c ? state.mb.c() : null;
    if (ctl && ctl.object) {
      ctl.target.set(p.x, p.y, p.z);
      state.mb.v.camera.position.set(p.x + 2, p.y + 18, p.z + 18);
      ctl.update();
    } else {
      // First-person mode — just place the camera at the bot.
      state.mb.v.camera.position.set(p.x, p.y + 2.2, p.z);
      state.mb.v.camera.lookAt(p.x, p.y, p.z + 10);
    }
  }

  function setFollow(on) {
    state.follow = !!on;
    if (state.follow && state.botPos && state.mb) {
      const ctl = state.mb.c ? state.mb.c() : null;
      if (ctl) {
        state.followOffset = state.mb.v.camera.position
          .clone()
          .sub(new state.mb.T.Vector3(state.botPos.x, state.botPos.y, state.botPos.z));
      } else {
        state.followOffset = new state.mb.T.Vector3(2, 18, 18);
      }
      moveToBot();
    }
  }

  function setLocate(on) {
    state.locate = !!on;
    applyLocate();
  }

  /* ---------- WASD camera movement ---------- */

  function onWasdKey(key, down) {
    const k = String(key || '').toLowerCase();
    const map = {
      w: 'w', arrowup: 'w',
      s: 's', arrowdown: 's',
      a: 'a', arrowleft: 'a',
      d: 'd', arrowright: 'd',
      shift: 'shift'
    };
    const target = map[k];
    if (!target) return;
    if (down && target !== 'shift' && state.follow) {
      // Manually moving the camera takes over from follow mode.
      state.follow = false;
      const fb = $('mb-follow-btn');
      if (fb) {
        fb.classList.remove('on');
        fb.innerHTML = mbIco('pin') + ' Follow bot';
      }
    }
    state.wasd[target] = down;
  }

  /** Pan the camera (and its orbit target) along the ground plane. */
  function moveCam(dt) {
    const mb = state.mb;
    if (!mb || !mb.v || !mb.v.camera) return;
    const w = state.wasd;
    const fwd = (w.w ? 1 : 0) - (w.s ? 1 : 0);
    const strafe = (w.d ? 1 : 0) - (w.a ? 1 : 0);
    if (!fwd && !strafe) return;

    const cam = mb.v.camera;
    const ctl = mb.c ? mb.c() : null;
    const speed = 26 * (w.shift ? 3 : 1); // blocks/sec; Shift = 3x

    // Forward + right vectors on the XZ plane, from the camera's view.
    let fx;
    let fz;
    let target = null;
    if (ctl && ctl.target) {
      target = ctl.target;
      let dx = target.x - cam.position.x;
      let dz = target.z - cam.position.z;
      const len = Math.hypot(dx, dz) || 1;
      fx = dx / len;
      fz = dz / len;
    } else {
      // First-person: flatten the camera's look direction.
      const dir = new mb.T.Vector3();
      cam.getWorldDirection(dir);
      fx = dir.x;
      fz = dir.z;
      const len = Math.hypot(fx, fz) || 1;
      fx /= len;
      fz /= len;
    }
    const rx = -fz;
    const rz = fx;

    const dx = (fx * fwd + rx * strafe) * speed * dt;
    const dz = (fz * fwd + rz * strafe) * speed * dt;
    cam.position.x += dx;
    cam.position.z += dz;
    if (target) {
      target.x += dx;
      target.z += dz;
      ctl.update();
    }
  }

  /* ---------- Wiring ---------- */

  function init() {
    const mb = state.mb;
    const T = mb.T;

    // --- Performance ---
    mb.r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    // Trim the meshing workers ONLY while no chunk sections are in flight.
    // WorldRenderer dispatches sections to workers by hash modulo the worker
    // count, so killing workers mid-stream would orphan already-dispatched
    // sections (permanent holes in the terrain). Trimming here — right after
    // the world (re)loads — is normally safe because no chunks have arrived
    // yet; if some have, we simply keep all workers (correctness first).
    const world = mb.v.world;
    const workers = world && world.workers;
    if (
      Array.isArray(workers) &&
      (!world.sectionsOutstanding || world.sectionsOutstanding.size === 0)
    ) {
      while (workers.length > 2) {
        const w = workers.pop();
        if (w && typeof w.terminate === 'function') {
          try { w.terminate(); } catch (_) { /* already terminated */ }
        }
      }
    }

    buildShared();

    // --- New world (re)loaded → drop stale markers ---
    mb.s.on('version', () => {
      clearMarkers();
      state.botPos = null;
    });

    // --- Bot position (server streams it on every move) ---
    mb.s.on('position', ({ pos, yaw }) => {
      if (!pos) return;
      state.botPos = pos;
      if (typeof yaw === 'number') state.botYaw = yaw;
      upsertMarker('__bot', pos, 'bot', true);
      if (state.follow) moveToBot();
    });

    // --- Other entities ---
    mb.s.on('entity', (e) => {
      if (e.delete) {
        removeMarker(e.id);
        return;
      }
      if (e.pos) upsertMarker(e.id, e.pos, classify(e), false, e);
    });

    // --- Page controls ---
    const moveBtn = $('mb-move-btn');
    const followBtn = $('mb-follow-btn');
    const locateBtn = $('mb-locate-btn');
    const reloadBtn = $('mb-reload-btn');
    if (moveBtn) moveBtn.addEventListener('click', moveToBot);
    if (followBtn) {
      followBtn.addEventListener('click', () => {
        state.follow = !state.follow;
        followBtn.classList.toggle('on', state.follow);
        followBtn.innerHTML = state.follow ? mbIco('pin') + ' Follow: ON' : mbIco('pin') + ' Follow bot';
        setFollow(state.follow);
      });
    }
    if (locateBtn) {
      locateBtn.addEventListener('click', () => {
        state.locate = !state.locate;
        locateBtn.classList.toggle('on', state.locate);
        locateBtn.innerHTML = state.locate ? mbIco('wand') + ' Locate: ON' : mbIco('wand') + ' Locate';
        setLocate(state.locate);
      });
    }
    if (reloadBtn) reloadBtn.addEventListener('click', () => window.location.reload());

    // --- WASD / arrow camera movement ---
    // Captured here when the iframe has focus; the parent map page also
    // forwards its key events via postMessage so WASD works everywhere.
    const WALK_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'];
    const onKeyEvent = (e, down) => {
      const k = e.key.toLowerCase();
      if (!WALK_KEYS.includes(k)) return;
      onWasdKey(k, down);
      e.preventDefault();
    };
    window.addEventListener('keydown', (e) => onKeyEvent(e, true));
    window.addEventListener('keyup', (e) => onKeyEvent(e, false));
    window.addEventListener('blur', () => {
      state.wasd.w = state.wasd.a = state.wasd.s = state.wasd.d = state.wasd.shift = false;
    });
    window.addEventListener('message', (e) => {
      const m = e.data;
      // map.js posts { __mbCtrl: { key, down } } — read the NESTED fields.
      const ctl = m && m.__mbCtrl;
      if (ctl && typeof ctl.key === 'string') onWasdKey(ctl.key, !!ctl.down);
    });

    // --- Stats + pulsing animation loop ---
    let lastStats = 0;
    const statsEl = $('mb-stats');
    const pulseEls = [];
    const tick = () => {
      requestAnimationFrame(tick);
      const now = performance.now();
      const dt = state.lastTick ? Math.min(0.1, (now - state.lastTick) / 1000) : 0;
      state.lastTick = now;
      if (state.wasd.w || state.wasd.a || state.wasd.s || state.wasd.d) moveCam(dt);
      if (state.botPos) {
        const botMarker = state.entities.get('__bot');
        if (botMarker && botMarker.glow && now % 1 === 0) {
          const s = 1 + Math.sin(now / 280) * 0.18;
          botMarker.glow.scale.set(s, s, 1);
        }
      }
      if (state.follow && state.botPos) {
        const ctl = state.mb.c ? state.mb.c() : null;
        if (ctl) {
          const p = state.botPos;
          const off = state.followOffset || new state.mb.T.Vector3(2, 18, 18);
          ctl.target.set(p.x, p.y, p.z);
          state.mb.v.camera.position.set(p.x + off.x, p.y + off.y, p.z + off.z);
          ctl.update();
        }
      }
      if (statsEl && now - lastStats > 500) {
        lastStats = now;
        const count = state.entities.size ? state.entities.size - (state.entities.has('__bot') ? 1 : 0) : 0;
        const pos = state.botPos
          ? `x ${Math.round(state.botPos.x)} · y ${Math.round(state.botPos.y)} · z ${Math.round(state.botPos.z)}`
          : '…';
        statsEl.innerHTML =
          `<div><span class="pulse-dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#34d399;margin-right:6px;"></span>` +
          `Viewer live · ${state.version ? 'MC ' + state.version : '…'}</div>` +
          `<div>${mbIco('robot')} Bot at ${pos}</div>` +
          `<div>${mbIco('eye')} ${count} entity marker${count === 1 ? '' : 's'} · ${Array.isArray(workers) ? workers.length + ' worker(s)' : ''}</div>`;
      }
    };
    tick();
  }

  /* ---------- Boot: wait for the bundle to expose __mb ---------- */

  function poll() {
    if (window.__mb && window.__mb.v && window.__mb.s) {
      state.mb = window.__mb;
      state.ready = true;
      const ver = $('mb-stats');
      if (ver) ver.style.opacity = '1';
      init();
      return;
    }
    setTimeout(poll, 120);
  }
  poll();
  // Give up after ~15s so the page never spins forever.
  setTimeout(() => {
    const statsEl = $('mb-stats');
    if (!state.ready && statsEl) {
      statsEl.innerHTML = `<div style="color:#fca5a5;">Viewer not connected yet — start the bot from the dashboard.</div>`;
    }
  }, 15000);
})();
