'use strict';

/* ============================================================
   MineBot — Command Commander store
   Persisted to commander.json (gitignored): who is allowed to
   command the bot from in-game chat, at what power level, and
   the command prefix.

   Power levels:
     4 = Owner   — everything (start / stop / drop all / config)
     3 = High    — most actions (reconnect, drop items, mine, attack)
     2 = Medium  — chat actions + viewing (say, effects, inventory)
     1 = Low     — read-only (status, stats, help)

   Unlisted players may chat normally but their commands are
   ignored by the bot.
   ============================================================ */

const fs = require('fs');
const path = require('path');

// DATA_DIR lets tests run against a throwaway directory so the user's real
// commander.json is never touched. Falls back to the project root.
const COMMANDER_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'commander.json')
  : path.join(__dirname, '..', '..', 'commander.json');

const LEVEL_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Owner' };
const LEVEL_RANGE = [1, 2, 3, 4];

const DEFAULT_STATE = {
  enabled: true, // master switch for the in-game commander
  prefix: '.', // e.g. ".inv", ".stats:health"
  players: [] // [{ name: 'Steve', level: 4 }]
};

let state = { ...DEFAULT_STATE, players: [] };

function init() {
  if (fs.existsSync(COMMANDER_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(COMMANDER_FILE, 'utf8'));
      state = normalize(raw);
    } catch (_) {
      state = { ...DEFAULT_STATE, players: [] };
    }
  }
  return get();
}

/** Sanitize arbitrary JSON into the expected shape (no validation errors). */
function normalize(raw) {
  const out = { ...DEFAULT_STATE, players: [] };
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.prefix === 'string' && raw.prefix.trim().length === 1) out.prefix = raw.prefix.trim();
    if (Array.isArray(raw.players)) {
      for (const p of raw.players) {
        if (!p || typeof p.name !== 'string') continue;
        const name = p.name.trim();
        const level = Number(p.level);
        if (!name || name.length > 32 || !LEVEL_RANGE.includes(level)) continue;
        if (out.players.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;
        out.players.push({ name, level });
      }
    }
  }
  return out;
}

/** Full config for the dashboard (safe to send to clients). */
function get() {
  return {
    enabled: state.enabled,
    prefix: state.prefix,
    players: state.players.map((p) => ({ ...p }))
  };
}

/** Power level (0-4) for a player name (case-insensitive). 0 = not authorized. */
function getLevel(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return 0;
  const found = state.players.find((p) => p.name.toLowerCase() === n);
  return found ? found.level : 0;
}

/** True when at least one commander is configured (gates the AI bridge). */
function isConfigured() {
  return state.players.length > 0;
}

/** Validate a save payload. Returns { ok, value } or { ok: false, errors }. */
function validate(partial = {}) {
  const errors = [];

  const enabled = typeof partial.enabled === 'boolean' ? partial.enabled : state.enabled;

  let prefix = typeof partial.prefix === 'string' ? partial.prefix.trim() : state.prefix;
  if (!prefix) prefix = '.';
  if (prefix.length !== 1) errors.push('Command prefix must be a single character (e.g. ".").');

  const players = [];
  if (!Array.isArray(partial.players)) {
    errors.push('players must be a list.');
  } else {
    const seen = new Set();
    for (const p of partial.players) {
      const name = String((p && p.name) || '').trim();
      const level = Number((p && p.level) !== undefined ? p.level : 0);
      let invalid = false;
      if (!name) {
        errors.push('Every player needs a name.');
        invalid = true;
      } else {
        if (name.length > 32) errors.push(`"${name}" is too long (max 32 characters).`);
        if (!/^[A-Za-z0-9_\- ]+$/.test(name)) errors.push(`"${name}" has invalid characters (letters, numbers, _, -, space only).`);
        const key = name.toLowerCase();
        if (seen.has(key)) {
          errors.push(`"${name}" is listed twice — each name can have only one power level.`);
          invalid = true;
        }
        seen.add(key);
      }
      if (!LEVEL_RANGE.includes(level)) {
        errors.push(`"${name || '(no name)'}" needs a power level of 1, 2, 3 or 4.`);
        invalid = true;
      }
      if (!invalid) players.push({ name, level });
    }
    if (players.length > 100) errors.push('Too many commanders (max 100).');
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { enabled, prefix, players } };
}

/** Save validated settings. */
function save(partial = {}) {
  const result = validate(partial);
  if (!result.ok) return result;
  state = result.value;
  fs.writeFileSync(COMMANDER_FILE, JSON.stringify(state, null, 2), 'utf8');
  return { ok: true, settings: get() };
}

module.exports = { init, get, getLevel, isConfigured, validate, save, LEVEL_NAMES, LEVEL_RANGE, DEFAULT_STATE, normalize };
