'use strict';

/* ============================================================
   MineBot — auto-restart watcher
   ------------------------------------------------------------
   `npm start` now runs THIS script instead of server.js directly.
   It boots server.js as a child process and watches the project's
   source files. When a code file changes — an editor save, a git
   pull, an in-place fix — the server is restarted automatically.
   No more Ctrl+C / double-clicking start.bat after every edit.

   - Runtime data files (config.json, users.json, ai-keys.json,
     ai-settings.json) are IGNORED, so saving settings in the
     dashboard never causes a restart loop.
   - On Render (RENDER=true) or with AUTO_RESTART=off the watcher is
     disabled and server.js runs in-process, exactly as before.
   - A crash-loop guard backs off after several quick exits; the next
     file change brings the server back.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');

const onRender = process.env.RENDER === 'true';
const enabled = !onRender && String(process.env.AUTO_RESTART || '').toLowerCase() !== 'off';

// "Code" that triggers a restart when it changes.
const WATCH_DIRS = ['src', 'public', 'scripts'];
const WATCH_FILES = ['server.js', 'package.json', 'package-lock.json', '.env', 'render.yaml'];
// Never restart for these (runtime data / lock files / deps / VCS).
const SKIP_DIRS = new Set(['node_modules', '.git']);
const SKIP_FILES = new Set([
  'config.json',
  'users.json',
  'sessions.json',
  'ai-keys.json',
  'ai-settings.json',
  '.test-lock'
]);

const POLL_MS = 1000; // how often we re-scan for changes
const DEBOUNCE_MS = 500; // wait this long after the LAST change before restarting
const RESPAWN_DELAY_MS = 800; // let the OS free the port before respawning
const KILL_GRACE_MS = 2000; // SIGTERM, then SIGKILL
const CRASH_WINDOW_MS = 5000; // crashes within this window count as a "streak"
const MAX_CRASHES = 5; // back off after this many quick exits

let child = null;
let snapshot = null;
let dirty = false;
let debounceTimer = null;
let crashStreak = 0;
let lastExitAt = 0;
let killing = false;

function log(msg) {
  console.log(`\n  ♻  ${msg}`);
}

/* ---------- file snapshot (mtime + size) ---------- */

function buildSnapshot() {
  const map = new Map();
  const stamp = (abs) => {
    let st;
    try {
      st = fs.statSync(abs);
    } catch (_) {
      return; // file deleted mid-scan — treat as no-op
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(abs))) return;
      let entries;
      try {
        entries = fs.readdirSync(abs);
      } catch (_) {
        return;
      }
      for (const e of entries) stamp(path.join(abs, e));
    } else {
      const name = path.basename(abs);
      if (SKIP_FILES.has(name)) return;
      map.set(abs, `${st.mtimeMs}:${st.size}`);
    }
  };
  for (const d of WATCH_DIRS) stamp(path.join(ROOT, d));
  for (const f of WATCH_FILES) stamp(path.join(ROOT, f));
  return map;
}

function scanForChanges() {
  const next = buildSnapshot();
  if (!snapshot) {
    snapshot = next;
    return;
  }
  if (next.size !== snapshot.size) {
    dirty = true;
  } else {
    for (const [k, v] of next) {
      if (snapshot.get(k) !== v) {
        dirty = true;
        break;
      }
    }
  }
  snapshot = next; // re-baseline immediately so one burst of saves = one restart
  if (dirty && !debounceTimer) {
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!dirty) return;
      dirty = false;
      restart();
    }, DEBOUNCE_MS);
  }
}

/* ---------- child process lifecycle ---------- */

function spawnServer() {
  if (child) return;
  child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: 'inherit',
    env: { ...process.env }
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (killing || !enabled) return; // we stopped it on purpose (or watcher is off)
    // Unexpected exit → restart, but back off if it keeps dying quickly
    // (e.g. a broken edit). The next file change always brings it back.
    const now = Date.now();
    if (now - lastExitAt > CRASH_WINDOW_MS) crashStreak = 0;
    lastExitAt = now;
    crashStreak += 1;
    if (crashStreak >= MAX_CRASHES) {
      crashStreak = 0;
      log(`Server exited quickly ${MAX_CRASHES} times in a row (code=${code} signal=${signal}).`);
      log('Waiting for a file change to restart it — fix the error and save any file.');
      return;
    }
    log(`Server stopped unexpectedly (code=${code} signal=${signal}) — restarting…`);
    setTimeout(() => {
      if (!child) spawnServer();
    }, 800);
  });
}

function stopChild(cb) {
  if (!child) return cb && cb();
  const c = child;
  killing = true;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    killing = false;
    if (cb) cb();
  };
  if (c.exitCode !== null || c.signalCode !== null) return finish(); // already dead
  c.once('exit', finish);
  try {
    c.kill('SIGTERM');
  } catch (_) {
    return finish();
  }
  setTimeout(() => {
    try {
      c.kill('SIGKILL');
    } catch (_) {
      /* already gone */
    }
  }, KILL_GRACE_MS);
}

function restart() {
  crashStreak = 0;
  if (!child) {
    spawnServer();
    return;
  }
  // NOTE (Windows): child.kill('SIGTERM') is TerminateProcess there, so the
  // server's graceful shutdown (botManager.destroy) does NOT run on an
  // auto-restart — the bot just disconnects, which is fine for a dev
  // reload. RESPAWN_DELAY_MS gives the OS time to free the port.
  log('Code change detected — restarting the server…');
  stopChild(() => {
    setTimeout(() => {
      if (!child) spawnServer();
    }, RESPAWN_DELAY_MS);
  });
}

/* ---------- signal forwarding (Ctrl+C / shutdown) ---------- */

function shutdown() {
  if (child) {
    try {
      child.kill('SIGTERM');
    } catch (_) {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 400);
  } else {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/* ---------- boot ---------- */

if (!enabled) {
  if (onRender) console.log('  ♻  Auto-restart disabled (Render) — running plain.');
  else console.log('  ♻  Auto-restart disabled (AUTO_RESTART=off) — running plain.');
  require(SERVER_ENTRY); // run server.js in THIS process, exactly like `node server.js`
} else {
  console.log('  ♻  Auto-restart ON — saving a file in src/, public/ or server.js will restart the server automatically.');
  console.log('     (Set AUTO_RESTART=off in .env to disable.)');
  snapshot = buildSnapshot();
  spawnServer();
  setInterval(scanForChanges, POLL_MS);
}
