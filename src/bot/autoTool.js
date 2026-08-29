'use strict';

/* ============================================================
   Auto-tool
   ---------
   Automatically equips the best tool before the bot digs or
   fights:

   - Digging:  pick the correct tool KIND from the block's
     `material` (mineable/pickaxe → pickaxe, mineable/shovel →
     shovel, mineable/axe → axe, …), honour the block's
     `harvestTools` tier gate (iron ore needs at least a stone
     pickaxe), then pick the highest material tier. Equal tiers
     are broken by durability (stone shovel beats golden shovel).
   - Fighting:  equip the highest-tier sword in the inventory.

   All selector functions are pure + exported so the test suite
   can exercise them without a live bot. `setAutoToolEnabled`
   wraps/unwraps `bot.dig` and `bot.attack` so ANY caller (AI
   tools, future dashboard actions) automatically benefits.
   ============================================================ */

/** Material → mining speed tier (used for both digging and combat). */
const MATERIAL_TIER = { wooden: 1, stone: 2, golden: 2, iron: 3, diamond: 4, netherite: 5 };

/** Armor material → defensive tier (turtle shell ≈ iron). */
const ARMOR_TIER = { leather: 1, golden: 2, chainmail: 2, iron: 3, turtle: 3, diamond: 4, netherite: 5 };

/** Armor piece name suffix → destination used by bot.equip. */
const ARMOR_DEST = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
const ARMOR_TYPES = ['helmet', 'chestplate', 'leggings', 'boots'];

/** 'diamond_helmet' → 'helmet' ('turtle_helmet' too via the _helmet suffix); 'dirt' → null. */
function armorTypeOf(name) {
  const n = String(name || '').toLowerCase().replace(/^[a-z0-9_]+:/, '');
  for (const t of ARMOR_TYPES) {
    if (n.endsWith('_' + t)) return t;
  }
  return null;
}

/** 'netherite_chestplate' → 5, 'turtle_helmet' → 3; unknown → 0. Strips namespaces. */
function armorTier(name) {
  const n = String(name || '').toLowerCase().replace(/^[a-z0-9_]+:/, '');
  if (n === 'turtle_helmet') return ARMOR_TIER.turtle;
  const m = n.match(/^(leather|golden|chainmail|iron|diamond|netherite)_/);
  return m ? ARMOR_TIER[m[1]] : 0;
}

/** Damage taken (0 = fresh); missing durabilityUsed counts as 0. */
const usedDamage = (item) => (item && Number.isFinite(item.durabilityUsed) ? item.durabilityUsed : 0);

/**
 * Best piece of a given armor type in the inventory: highest material tier,
 * equal tiers broken by remaining durability (least damaged wins).
 */
function bestArmorForSlot(slotType, items, registry) {
  const itemsArr = Array.isArray(items) ? items : [];
  let best = null;
  let bestScore = -1;
  for (const item of itemsArr) {
    const def = registry && registry.items && registry.items[item.type] ? registry.items[item.type] : null;
    if (!def) continue;
    if (armorTypeOf(def.name) !== slotType) continue;
    const score = armorTier(def.name);
    const dmg = usedDamage(item);
    if (score > bestScore || (score === bestScore && dmg < usedDamage(best))) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Which armor to put on: for each slot, equip when the best owned piece is a
 * strictly better tier — or the SAME tier but in better condition than what's
 * worn (so a nearly-broken piece gets swapped for a fresh one).
 * worn: { head, torso, legs, feet } each prismarine item or null.
 */
function armorUpgradesToEquip(worn, items, registry) {
  const out = [];
  const wornMap = worn || {};
  for (const [type, dest] of Object.entries(ARMOR_DEST)) {
    const wornItem = wornMap[dest] || null;
    const best = bestArmorForSlot(type, items, registry);
    if (!best) continue;
    if (wornItem) {
      const wt = armorTier(wornItem.name);
      const bt = armorTier(best.name);
      if (bt < wt) continue; // never downgrade
      if (bt === wt && usedDamage(best) >= usedDamage(wornItem)) continue; // same tier, not better condition
    }
    out.push({ item: best, dest });
  }
  return out;
}

/** Block material ("mineable/…") → the tool type that digs it fastest. */
const MATERIAL_TO_TOOL = {
  'mineable/pickaxe': 'pickaxe',
  'mineable/axe': 'axe',
  'mineable/shovel': 'shovel',
  'mineable/hoe': 'hoe',
  'mineable/sword': 'sword'
};

const TOOL_TYPES = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];

/** 'diamond_pickaxe' → 'pickaxe'; 'dirt' → null. Handles any namespace prefix. */
function toolTypeOf(name) {
  const n = String(name || '').toLowerCase().replace(/^[a-z0-9_]+:/, '');
  for (const t of TOOL_TYPES) {
    if (n.endsWith('_' + t)) return t;
  }
  return null;
}

/** 'diamond_pickaxe' → 4; unknown materials → 0. */
function toolTier(name) {
  const m = String(name || '').toLowerCase().match(/^(wooden|stone|golden|iron|diamond|netherite)_/);
  return m ? MATERIAL_TIER[m[1]] : 0;
}

/** Strip a 'minecraft:stone_pickaxe' style name down to 'stone_pickaxe'. */
function plainName(name) {
  return String(name || '').split(':').pop();
}

/**
 * The tool TYPE that digs a block fastest (from its material), or null when
 * the block needs no tool / can't be auto-tooled. Falls back to scanning
 * harvestTools when the material isn't the usual "mineable/…" value (e.g.
 * the odd "incorrect_for_wooden_tool" material on some ores in old data).
 */
function toolTypeForBlock(blockDef) {
  if (!blockDef) return null;
  const material = String(blockDef.material || '');
  if (MATERIAL_TO_TOOL[material]) return MATERIAL_TO_TOOL[material];
  if (Array.isArray(blockDef.harvestTools) && blockDef.harvestTools.length) {
    for (const h of blockDef.harvestTools) {
      const t = toolTypeOf(plainName(h));
      if (t && t !== 'sword') return t;
    }
  }
  return null;
}

/**
 * Best digging tool for a block out of the given inventory items.
 * Respects the block's harvestTools tier gate (null when the bot only has
 * tools too weak for the block). Equal tiers are broken by durability.
 */
function bestToolForBlock(block, items, registry) {
  if (!block) return null;
  const itemsArr = Array.isArray(items) ? items : [];
  const blockDef = registry && registry.blocks && registry.blocks[block.type] ? registry.blocks[block.type] : null;
  const needed = toolTypeForBlock(blockDef);
  if (!needed) return null;

  const harvestNames = blockDef && Array.isArray(blockDef.harvestTools)
    ? blockDef.harvestTools.map(plainName)
    : null;

  let best = null;
  let bestDef = null;
  let bestScore = -1;
  for (const item of itemsArr) {
    const def = registry && registry.items && registry.items[item.type] ? registry.items[item.type] : null;
    if (!def) continue;
    if (toolTypeOf(def.name) !== needed) continue;
    if (harvestNames && harvestNames.length && !harvestNames.includes(def.name)) continue;
    const score = toolTier(def.name);
    const durability = def.maxDurability || 0;
    if (score > bestScore || (score === bestScore && durability > (bestDef ? bestDef.maxDurability || 0 : -1))) {
      best = item;
      bestDef = def;
      bestScore = score;
    }
  }
  return best;
}

/** Best sword in the inventory by material tier (null if none). */
function bestSword(items, registry) {
  const itemsArr = Array.isArray(items) ? items : [];
  let best = null;
  let bestScore = -1;
  for (const item of itemsArr) {
    const def = registry && registry.items && registry.items[item.type] ? registry.items[item.type] : null;
    if (!def) continue;
    if (toolTypeOf(def.name) !== 'sword') continue;
    const score = toolTier(def.name);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

/** Equip `item` unless it's already in the bot's hand. Never throws. */
async function equipBest(bot, item, hooks) {
  if (!bot || !item) return;
  const held = bot.heldItem;
  if (held && held.type === item.type) return; // already holding the best tool
  if (hooks && hooks.closeContainer) {
    try { hooks.closeContainer(); } catch (_) { /* ignore */ }
  }
  try {
    await bot.equip(item, 'hand');
    if (hooks && hooks.onEquip) hooks.onEquip(item);
  } catch (_) {
    /* equip hiccups (busy window, item vanished) — let the action proceed */
  }
}

/**
 * Wrap (or unwrap) `bot.dig` + `bot.attack` so the best tool is equipped
 * first. Safe to call repeatedly; idempotent per state.
 *
 * hooks: { closeContainer(), onEquip(item) }
 */
function setAutoToolEnabled(bot, enabled, hooks = {}) {
  if (!bot) return;

  if (enabled && !bot._autoToolWrapped) {
    bot._autoToolWrapped = true;
    bot._origDig = bot.dig;
    bot._origAttack = bot.attack;

    bot.dig = async function autoDig(block) {
      try {
        const item = bestToolForBlock(block, bot.inventory.items(), bot.registry);
        if (item) await equipBest(bot, item, hooks);
      } catch (_) {
        /* never block a dig because of tool logic */
      }
      return bot._origDig.call(bot, block);
    };

    bot.attack = async function autoAttack(target, swing) {
      try {
        const item = bestSword(bot.inventory.items(), bot.registry);
        if (item) await equipBest(bot, item, hooks);
      } catch (_) {
        /* never block an attack because of tool logic */
      }
      return bot._origAttack.call(bot, target, swing);
    };
  } else if (!enabled && bot._autoToolWrapped) {
    bot.dig = bot._origDig;
    bot.attack = bot._origAttack;
    bot._autoToolWrapped = false;
  }
}

module.exports = {
  MATERIAL_TIER,
  MATERIAL_TO_TOOL,
  TOOL_TYPES,
  toolTypeOf,
  toolTier,
  plainName,
  toolTypeForBlock,
  bestToolForBlock,
  bestSword,
  equipBest,
  setAutoToolEnabled,
  ARMOR_TIER,
  ARMOR_DEST,
  ARMOR_TYPES,
  armorTypeOf,
  armorTier,
  bestArmorForSlot,
  armorUpgradesToEquip
};
