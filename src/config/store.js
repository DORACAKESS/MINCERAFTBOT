'use strict';

const fs = require('fs');
const path = require('path');

// DATA_DIR lets tests run against a throwaway directory so the user's real
// config.json is never touched. Falls back to the project root when unset.
const CONFIG_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'config.json')
  : path.join(__dirname, '..', '..', 'config.json');

const DEFAULT_CONFIG = {
  botName: 'MineBot',
  serverIp: 'localhost',
  serverPort: 25565,
  version: '1.20.1',
  auth: 'offline',
  // Server login (AuthMe-style auth plugins on cracked servers).
  loginEnabled: false,
  loginPassword: '',
  loginAutoDetect: true,
  loginDelaySeconds: 5,
  // Quick-access history of recently used servers (newest first).
  serverHistory: [],
  // Inventory helpers: auto-drop a named item + auto-eat when hunger is low
  // + auto-tool (equip best pickaxe/sword when digging/fighting)
  // + auto-armor (equip the best armor pieces by material).
  autoDropEnabled: false,
  autoDropItem: '',
  autoEatEnabled: false,
  autoEatThreshold: 10,
  autoToolEnabled: false,
  autoArmorEnabled: false,
  // Follow-player control (Controls page).
  followEnabled: false,
  followPlayer: '',
  followMode: 'survival', // survival (walk) | op (/tp)
  followRadius: 5,
  // Guard-player control (Controls page): follow + attack threats.
  guardEnabled: false,
  guardPlayer: '',
  guardMode: 'survival',
  guardRadius: 5,
  guardAttackRange: 8,
  guardHostile: true, // auto-attack hostile mobs
  guardPassive: true, // retaliate against passive mobs that hit us
  guardPlayers: false, // retaliate against players that hit us
  // Look at the nearest player (pure head-turn, no movement).
  lookAtPlayers: false,
  // Mining control (Controls page): the bot digs a tunnel straight ahead
  // (1x2 straight) or a descending 1:1 staircase. Mutual-exclusive with
  // Follow/Guard (all three drive the same movement keys).
  miningEnabled: false,
  miningMode: 'straight', // straight | stair
  savedAt: null
};

/** Read config.json, merging saved values over defaults. Never throws. */
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...DEFAULT_CONFIG, ...raw };
    }
  } catch (err) {
    console.error(`[config] Could not read config.json (${err.message}). Using defaults.`);
  }
  return { ...DEFAULT_CONFIG };
}

/** Persist config.json, merging over the existing values. Returns the saved config. */
function saveConfig(partial) {
  const next = { ...loadConfig(), ...partial, savedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** True when an admin has saved settings at least once (config.json exists). */
function configExists() {
  return fs.existsSync(CONFIG_PATH);
}

const MAX_HISTORY = 8;
const historyKey = (e) => `${String(e && e.ip).toLowerCase()}:${Number(e && e.port)}`;

/** Add (or move to front) a server in the quick-access history. Returns the new list. */
function addServerHistory({ ip, port, version } = {}) {
  const cfg = loadConfig();
  const key = historyKey({ ip, port });
  const rest = (cfg.serverHistory || []).filter((e) => historyKey(e) !== key);
  rest.unshift({ ip: String(ip || ''), port: Number(port) || 25565, version: String(version || ''), lastUsed: new Date().toISOString() });
  cfg.serverHistory = rest.slice(0, MAX_HISTORY);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg.serverHistory;
}

/** Remove a server from history (matched by ip:port). Returns { ok, history } or { ok:false, error }. */
function removeServerHistory(ip, port) {
  const cfg = loadConfig();
  const key = historyKey({ ip, port });
  const before = (cfg.serverHistory || []).length;
  cfg.serverHistory = (cfg.serverHistory || []).filter((e) => historyKey(e) !== key);
  if (cfg.serverHistory.length === before) return { ok: false, error: 'Not in history.' };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return { ok: true, history: cfg.serverHistory };
}

module.exports = { loadConfig, saveConfig, configExists, addServerHistory, removeServerHistory, CONFIG_PATH, DEFAULT_CONFIG };
