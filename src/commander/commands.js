'use strict';

/* ============================================================
   MineBot — Command Commander: command tree + parser
   ------------------------------------------------------------
   Pure functions (no I/O) so the parsing / level-gating / help
   text can be unit-tested without a live bot.

   Syntax (prefix default "."):
     .help                       -> page 1 of ALL commands (one per line)
     .help 2                     -> page 2 of the full command list
     .help <category>            -> list a category's commands
     .help <category> <page>     -> page N of a category's commands
     .help <category> <command>  -> details of one command (+ sub-commands)
     .<command>                  -> run a command, e.g. .inv
     .<command>:<subcommand> ... -> run a sub-command, e.g. .stats:health,
                                    .inv:drop cobblestone, .bot:say hi

   Every .help listing is one command per line so players can find a
   command quickly, and long listings are paginated (footer shows the
   current page + how to see the next one).

   Power levels:
     4 Owner / 3 High / 2 Medium / 1 Low (see store.js).
   ============================================================ */

const LEVEL_NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Owner' };

/** Commands shown per .help page (each line = one chat message). */
const HELP_PAGE_SIZE = 5;

/**
 * The command tree. Each category has a base level (for bare `.cat` runs)
 * and optional subcommands with their own levels. `.help` is itself a
 * category so it shows up in the reference + `.help` output.
 */
const CATEGORIES = [
  {
    id: 'help',
    level: 1,
    description: 'Command help — .help, .help <category>, .help <category> <command>',
    subcommands: []
  },
  {
    id: 'bot',
    level: 1,
    description: 'Bot control — status, say, reconnect, start, stop, mine, attack',
    subcommands: [
      { id: 'state', level: 1, description: 'Show the bot status (stopped / connecting / connected)' },
      { id: 'say', level: 2, arg: 'text', description: 'Make the bot say <text> in the Minecraft chat' },
      { id: 'reconnect', level: 3, description: 'Reconnect to the last server the bot was on' },
      { id: 'mine', level: 3, arg: 'block', description: 'Dig the nearest matching block (best tool auto-equipped)' },
      { id: 'attack', level: 3, arg: 'target?', description: 'Attack the nearest entity, or a named one' },
      { id: 'start', level: 4, description: 'Start the bot with the saved server settings' },
      { id: 'stop', level: 4, description: 'Stop / disconnect the bot' }
    ]
  },
  {
    id: 'stats',
    level: 1,
    description: 'Bot vitals — health, hunger, XP, position, effects',
    subcommands: [
      { id: 'health', level: 1, description: 'Show health' },
      { id: 'hunger', level: 1, description: 'Show hunger / food' },
      { id: 'xp', level: 1, description: 'Show XP level and progress' },
      { id: 'pos', level: 1, description: 'Show the bot position' },
      { id: 'effects', level: 2, description: 'List active potion effects' }
    ]
  },
  {
    id: 'inv',
    level: 2,
    description: 'Inventory — see, drop a stack, drop everything',
    subcommands: [
      { id: 'drop', level: 3, arg: 'item count?', description: 'Drop a stack by name (.inv:drop cobblestone or .inv:drop cobblestone 5)' },
      { id: 'dropall', level: 4, description: 'Drop the whole inventory (not armor / offhand)' }
    ]
  }
];

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

/** The base category a command belongs to (case-insensitive) or null. */
function category(id) {
  const key = String(id || '').trim().toLowerCase();
  return byId.get(key) || null;
}

/** A subcommand of a category (case-insensitive) or null. */
function subcommand(cat, id) {
  if (!cat) return null;
  const key = String(id || '').trim().toLowerCase();
  return cat.subcommands.find((s) => s.id === key) || null;
}

/**
 * Parse a raw in-game message into a command invocation.
 * Returns null when the message is not a commander command.
 *
 * Invocation shape:
 *   { category: 'bot', command: 'say'|null, args: [...], raw: 'rest' }
 *   .help keeps its raw args so the handler can interpret 0/1/2 levels.
 */
function parseCommand(message, prefix = '.') {
  const text = String(message || '').trim();
  const pre = String(prefix || '.').trim() || '.';
  if (!text.startsWith(pre)) return null;
  const rest = text.slice(pre.length).trim();
  if (!rest) return null;

  // Split head ("bot:say" / "stats" / "inv:drop") from args ("hello world").
  const sp = rest.search(/\s/);
  const head = sp === -1 ? rest.toLowerCase() : rest.slice(0, sp).toLowerCase();
  const argsStr = sp === -1 ? '' : rest.slice(sp + 1).trim();

  if (!head) return null;

  // help keeps the WHOLE rest (up to 2 tokens) as its arguments.
  if (head === 'help') {
    const parts = argsStr.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s.toLowerCase());
    return { category: 'help', command: null, args: parts, raw: rest };
  }

  const colon = head.indexOf(':');
  const catId = colon === -1 ? head : head.slice(0, colon);
  const subId = colon === -1 ? '' : head.slice(colon + 1);
  const cat = category(catId);
  if (!cat) {
    return { category: null, command: null, args: [], raw: rest, unknown: catId };
  }

  let command = null;
  if (subId) {
    const sub = subcommand(cat, subId);
    if (!sub) {
      return { category: cat, command: null, args: [], raw: rest, unknownSub: subId };
    }
    command = sub.id;
  }

  const args = argsStr ? argsStr.split(/\s+/).filter((s) => s.length) : [];
  return { category: cat.id, command, args, raw: rest };
}

/** Minimum power level needed to run an invocation (sub-command level wins). */
function requiredLevel(inv) {
  if (!inv || !inv.category) return 1;
  const cat = category(inv.category);
  if (!cat) return 1;
  if (inv.command) {
    const sub = subcommand(cat, inv.command);
    if (sub) return sub.level;
  }
  return cat.level;
}

/** True when the invocation is a permission failure for `playerLevel`. */
function denied(inv, playerLevel) {
  if (!inv || !inv.category) return true;
  return playerLevel < requiredLevel(inv);
}

/** Compact chat-safe help: "Level X (Name) — description". */
function levelLabel(level) {
  return `Level ${level} (${LEVEL_NAMES[level] || '?'})`;
}

/** Syntax for one command (+ sub-command), e.g. ".inv:drop <item count?>". */
function syntax(cat, sub) {
  const name = sub ? `${cat.id}:${sub.id}` : cat.id;
  const arg = sub ? sub.arg : null;
  return arg ? `.${name} <${arg}>` : `.${name}`;
}

/* ---- .help builders (all return short chat lines) ---- */

/**
 * Flat list of every runnable command (bare category + sub-commands), in
 * display order. Used by the paginated `.help` listing.
 */
function flatCommands() {
  const out = [];
  for (const cat of CATEGORIES) {
    out.push({
      syntax: `.${cat.id}`,
      level: cat.level,
      desc: cat.description.split('—')[0].trim()
    });
    for (const sub of cat.subcommands || []) {
      out.push({ syntax: syntax(cat, sub), level: sub.level, desc: sub.description });
    }
  }
  return out;
}

/**
 * Paginated `.help` listing — every command on its own line.
 * Returns { page, totalPages, lines } where the LAST line is the page
 * footer (current page / total / how to see the next page). Out-of-range
 * pages return a single friendly line instead of an empty page.
 */
function helpPage(page = 1, perPage = HELP_PAGE_SIZE) {
  const all = flatCommands();
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const requested = Math.floor(Number(page) || 1);
  const p = Math.min(Math.max(1, requested), totalPages);

  if (requested > totalPages) {
    return {
      page: totalPages,
      totalPages,
      lines: [`⚠ That's ${totalPages} page${totalPages === 1 ? '' : 's'} of commands — type .help 1 to start.`]
    };
  }
  if (requested < 1) {
    return { page: 1, totalPages, lines: ['⚠ Page must be 1 or more — type .help for the first page.'] };
  }

  const slice = all.slice((p - 1) * perPage, p * perPage);
  const lines = slice.map((c) => `${c.syntax} (${levelLabel(c.level)}) — ${c.desc}`);
  if (totalPages > 1) {
    const next = p < totalPages ? p + 1 : 1;
    lines.push(`📄 Page ${p}/${totalPages} — type .help ${next} for ${p < totalPages ? 'more' : 'the first page'}`);
  } else {
    lines.push('📄 All commands shown — .help <category> for details');
  }
  return { page: p, totalPages, lines };
}

/**
 * Paginated `.help <category>` listing (sub-commands one per line).
 * Returns { page, totalPages, lines }. Unknown categories get a single
 * friendly line so the footer logic stays uniform.
 */
function helpCategoryPage(catId, page = 1, perPage = HELP_PAGE_SIZE) {
  const cat = category(catId);
  if (!cat) return { page: 1, totalPages: 1, lines: [`Unknown category "${catId}". Try .help`] };
  if (!cat.subcommands.length) {
    return { page: 1, totalPages: 1, lines: [`${levelLabel(cat.level)} — ${cat.description}`] };
  }
  const all = cat.subcommands.map((s) => `${syntax(cat, s)} (${levelLabel(s.level)}) — ${s.description}`);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const requested = Math.floor(Number(page) || 1);
  const p = Math.min(Math.max(1, requested), totalPages);
  if (requested > totalPages) {
    return { page: totalPages, totalPages, lines: [`⚠ "${cat.id}" has only ${totalPages} page${totalPages === 1 ? '' : 's'} — type .help ${cat.id} to start.`] };
  }
  const lines = [`⚡ ${cat.id} commands:`, ...all.slice((p - 1) * perPage, p * perPage)];
  if (totalPages > 1) {
    lines.push(`📄 Page ${p}/${totalPages} — type .help ${cat.id} ${p + 1} for more`);
  }
  return { page: p, totalPages, lines };
}

/** `.help` — list every category with a one-line summary. */
function helpCategories() {
  const lines = CATEGORIES.map((c) => `.${c.id} — ${c.description}`);
  return ['⚡ Command categories:', ...lines, 'Tip: .help <category> lists its commands.'];
}

/** `.help <category>` — list the commands (+ sub-commands) of a category. */
function helpCategory(catId) {
  const cat = category(catId);
  if (!cat) return [`Unknown category "${catId}". Try .help`];
  if (!cat.subcommands.length) {
    return [`${levelLabel(cat.level)} — ${cat.description}`];
  }
  const lines = cat.subcommands.map((s) => `${syntax(cat, s)} (${levelLabel(s.level)}) — ${s.description}`);
  return [`⚡ ${cat.id} commands:`, ...lines];
}

/** `.help <category> <command>` — details of one command / sub-command. */
function helpCommand(catId, subId) {
  const cat = category(catId);
  if (!cat) return [`Unknown category "${catId}". Try .help`];
  if (subId === 'list' || subId === 'all') {
    return helpCategory(catId);
  }
  const sub = subcommand(cat, subId);
  if (!sub) return [`Unknown command ".${cat.id}:${subId}". Try .help ${cat.id}`];
  return [
    `${syntax(cat, sub)} — ${sub.description}`,
    `Allowed for ${levelLabel(sub.level)} or higher.`
  ];
}

module.exports = {
  CATEGORIES,
  LEVEL_NAMES,
  category,
  subcommand,
  parseCommand,
  requiredLevel,
  denied,
  syntax,
  helpCategories,
  helpCategory,
  helpCommand,
  helpPage,
  helpCategoryPage,
  flatCommands,
  HELP_PAGE_SIZE
};
