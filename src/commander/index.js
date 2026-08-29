'use strict';

/* ============================================================
   MineBot — Command Commander engine
   ------------------------------------------------------------
   Listens to in-game chat (wired from server.js on the
   botManager 'game-chat' event). Only players listed in the
   commander store (with a power level) can command the bot:

     .help                      list categories
     .help <category>           list a category's commands
     .help <category> <command> details of one command
     .stats:health              sub-commands use ":"
     .inv:drop cobblestone      args after the command
     .bot:say hello             etc.

   Unlisted players may chat normally — their commands are
   ignored (and never reach the bot).
   ============================================================ */

const { loadConfig } = require('../config/store');
const {
  parseCommand,
  denied,
  requiredLevel,
  LEVEL_NAMES,
  helpCategories,
  helpCategory,
  helpCommand,
  helpPage,
  helpCategoryPage
} = require('./commands');

function createCommander({ store, getBotManager }) {
  /** Handle one in-game chat line from `username`. Resolves to the reply (or null). */
  async function handleChat(username, message) {
    const cfg = store.get();
    if (!cfg.enabled) return null;
    const level = store.getLevel(username);
    if (!level) return null; // not authorized — normal chat, no commands
    const inv = parseCommand(message, cfg.prefix);
    if (!inv) return null; // not a command
    return runCommand(inv, level);
  }

  /** Execute a parsed command for a player with `level` power. Returns chat reply. */
  async function runCommand(inv, level) {
    if (!inv || !inv.category) {
      return inv && inv.unknown ? `Unknown command ".${inv.unknown}". Try .help` : null;
    }
    if (denied(inv, level)) {
      const need = requireLevelLabel(inv);
      return `⛔ You need ${need} for that command.`;
    }

    const bm = getBotManager();
    try {
      if (inv.category === 'help') return runHelp(inv.args);
      if (inv.category === 'bot') return runBot(bm, inv.command, inv.args);
      if (inv.category === 'stats') return runStats(bm, inv.command);
      if (inv.category === 'inv') return runInv(bm, inv.command, inv.args);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log(bm, 'error', `[Commander] ${inv.category}:${inv.command || ''} failed: ${msg}`);
      return `⚠ ${msg}`;
    }
    return null;
  }

  /**
   * Normalize a reply into an array of chat lines (never null/empty).
   * Commander replies may be a single string OR an array of lines (the
   * paginated .help listings) — server.js sends each line separately.
   */
  function toLines(reply) {
    if (Array.isArray(reply)) return reply.filter((l) => l && String(l).trim());
    if (reply && String(reply).trim()) return [String(reply)];
    return [];
  }

  /* ---- .help ---- */
  // Returns an ARRAY of chat lines (one command per line) so server.js can
  // send each as its own in-game message — players can read commands one at
  // a time instead of one huge wall of text. Long listings are paginated:
  //   .help            -> page 1 of ALL commands
  //   .help 2          -> page 2 of ALL commands
  //   .help bot        -> all bot commands
  //   .help bot 2      -> page 2 of the bot commands
  //   .help bot start  -> details of one command
  function runHelp(args) {
    const a = args || [];
    if (!a.length) return helpPage(1).lines;
    const first = a[0];
    if (/^\d+$/.test(first)) return helpPage(Number(first)).lines;
    if (a.length === 1) return helpCategory(first);
    // Two args: second is either a page number (.help bot 2) or a command
    // name (.help bot start).
    if (/^\d+$/.test(a[1])) return helpCategoryPage(first, Number(a[1])).lines;
    return helpCommand(first, a[1]);
  }

  /* ---- bot ---- */

  function runBot(bm, command, args) {
    if (!command) {
      // Bare ".bot" — status summary.
      return `🤖 ${stateText(bm)} — use .bot:<sub> e.g. .bot:state, .bot:say hi (see .help bot)`;
    }
    if (command === 'state') return `🤖 ${stateText(bm)}`;
    if (command === 'say') {
      const text = (args || []).join(' ').trim();
      if (!text) return '⚠ Usage: .bot:say <text>';
      if (!bm.sendChat(text)) return '⚠ Bot is not in a server — start it first.';
      log(bm, 'info', `[Commander] bot said: ${text}`);
      return `🗨 Said: ${text.slice(0, 120)}`;
    }
    if (command === 'reconnect') {
      bm.reconnect();
      log(bm, 'info', '[Commander] reconnect requested');
      return '🔁 Reconnecting…';
    }
    if (command === 'start') {
      if (bm.state === 'connected' || bm.state === 'connecting') {
        return `🤖 Bot is already ${bm.state}.`;
      }
      bm.start(loadConfig());
      log(bm, 'info', '[Commander] bot start requested');
      return '⚡ Starting the bot…';
    }
    if (command === 'stop') {
      bm.stop();
      log(bm, 'info', '[Commander] bot stopped');
      return '🛑 Bot stopped.';
    }
    if (command === 'mine') {
      const block = (args || []).join(' ').trim().toLowerCase();
      if (!block) return '⚠ Usage: .bot:mine <block>';
      if (!connected(bm)) return '⚠ Bot is not in a server — start it first.';
      return bm.mineBlock(block).then((res) => {
        log(bm, 'info', `[Commander] mine ${block} -> ${res.ok ? 'ok' : res.error}`);
        return res.ok ? `⛏ Mined ${res.block}.` : `⚠ ${res.error}`;
      });
    }
    if (command === 'attack') {
      const target = (args || []).join(' ').trim().toLowerCase() || undefined;
      if (!connected(bm)) return '⚠ Bot is not in a server — start it first.';
      return bm.attackEntity(target).then((res) => {
        log(bm, 'info', `[Commander] attack -> ${res.ok ? res.target : res.error}`);
        return res.ok ? `⚔ Attacked ${res.target}.` : `⚠ ${res.error}`;
      });
    }
    return `⚠ Unknown .bot command. See .help bot`;
  }

  /* ---- stats ---- */

  function runStats(bm, command) {
    const inv = connected(bm) ? bm.getInventory() : null;
    const snap = bm.snapshot();
    if (!command) {
      // Bare ".stats" — the essentials in one line.
      if (!inv) return `🤖 ${stateText(bm)} — no vitals (bot not in a server).`;
      return [
        `${stateText(bm)}`,
        `❤️ Health ${inv.health}/20 · 🍖 Hunger ${inv.food}/20`,
        `✨ XP ${inv.experience ? inv.experience.level : '?'} · 📍 ${posText(bm)}`
      ].join(' ');
    }
    if (command === 'health') return inv ? `❤️ Health ${inv.health}/20` : `🤖 ${stateText(bm)} — not in a server.`;
    if (command === 'hunger') return inv ? `🍖 Hunger ${inv.food}/20 (saturation ${inv.foodSaturation})` : `🤖 ${stateText(bm)} — not in a server.`;
    if (command === 'xp') {
      if (!inv || !inv.experience) return `🤖 ${stateText(bm)} — not in a server.`;
      const e = inv.experience;
      return `✨ Level ${e.level} · ${e.points} XP (${Math.round((e.progress || 0) * 100)}% to next)`;
    }
    if (command === 'pos') return inv ? `📍 ${posText(bm)}` : `🤖 ${stateText(bm)} — not in a server.`;
    if (command === 'effects') {
      if (!inv) return `🤖 ${stateText(bm)} — not in a server.`;
      const effects = inv.effects || [];
      if (!effects.length) return '✨ No active potion effects.';
      return `✨ Effects: ${effects.slice(0, 5).map((e) => `${e.displayName} ${e.amplifier}`).join(', ')}`;
    }
    return `⚠ Unknown .stats command. See .help stats`;
  }

  /* ---- inv ---- */

  function runInv(bm, command, args) {
    if (!connected(bm)) return '⚠ Bot is not in a server — start it first.';
    if (!command) {
      // Bare ".inv" — compact inventory summary.
      const inv = bm.getInventory();
      if (!inv) return '🎒 Inventory unavailable.';
      const total = inv.items.reduce((n, i) => n + (i.count || 1), 0);
      const armor = (inv.armor || []).filter(Boolean).map((i) => i.displayName).join(', ');
      const parts = [`🎒 ${inv.items.length} stacks · ${total} items`];
      if (armor) parts.push(`🛡 ${armor}`);
      if (inv.offhand) parts.push(`✋ ${inv.offhand.displayName}`);
      parts.push('See .help inv for drop commands');
      return parts.join(' | ');
    }
    if (command === 'drop') {
      const name = String((args && args[0]) || '').trim().toLowerCase();
      if (!name) return '⚠ Usage: .inv:drop <item> [count]  e.g. .inv:drop cobblestone 5';
      let count;
      if (args && args[1] !== undefined && args[1] !== '') {
        count = Number(args[1]);
        if (!Number.isInteger(count) || count < 1) {
          // A bad count must NEVER fall through to "drop everything".
          return '⚠ Count must be a whole number — e.g. .inv:drop cobblestone 5 (or omit it to drop all stacks)';
        }
      }
      return bm.dropItem(name, count).then((res) => {
        log(bm, 'info', `[Commander] drop ${name} -> ${res.ok ? res.items + ' dropped' : res.error}`);
        return res.ok
          ? `🗑 Dropped ${res.items} × ${name}.`
          : `⚠ ${res.error}`;
      });
    }
    if (command === 'dropall') {
      return bm.dropAll().then((res) => {
        log(bm, 'info', `[Commander] dropall -> ${res.ok ? res.dropped + ' stacks' : res.error}`);
        return res.ok ? `🗑 Dropped ${res.dropped} stacks — backpack empty.` : `⚠ ${res.error}`;
      });
    }
    return `⚠ Unknown .inv command. See .help inv`;
  }

  /* ---- helpers ---- */

  function connected(bm) {
    return !!(bm && bm.state === 'connected' && bm.bot);
  }

  function stateText(bm) {
    const snap = bm ? bm.snapshot() : null;
    if (!snap) return 'Bot state unknown.';
    let s = `Bot is ${snap.state}.`;
    if (snap.config) s += ` Server: ${snap.config.serverIp}:${snap.config.serverPort}`;
    return s;
  }

  function posText(bm) {
    try {
      const p = bm.bot && bm.bot.entity && bm.bot.entity.position;
      return p ? `x=${Math.round(p.x)} y=${Math.round(p.y)} z=${Math.round(p.z)}` : 'unknown';
    } catch (_) {
      return 'unknown';
    }
  }

  function log(bm, level, message) {
    try {
      if (bm && typeof bm.emitLog === 'function') bm.emitLog(level, message);
    } catch (_) {
      /* ignore */
    }
  }

  return { handleChat, runCommand, toLines };
}

/** Tiny helper for the denial message. */
function requireLevelLabel(inv) {
  const lvl = requiredLevel(inv);
  return `Level ${lvl} (${LEVEL_NAMES[lvl] || '?'})`;
}

module.exports = { createCommander };
