'use strict';

/* ============================================================
   Bot inventory — snapshot builder + pure normalizers
   ------------------------------------------------------------
   Turns the raw Mineflayer inventory into a JSON-safe shape the
   dashboard can render: display names, counts, durability,
   enchantments (modern "Enchantments" + legacy "ench" NBT),
   shulker box contents (parsed from BlockEntityTag.Items), and
   the correct Minecraft texture folder for the bot's version.

   Everything is a pure function of (item, registry) so the
   parsing logic can be unit-tested without a live bot.
   ============================================================ */

/** "item" texture folder for a Minecraft version (1.13+ renamed items/ → item/). */
function textureFolderFor(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  if (!m) return 'item';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 1 || (major === 1 && minor >= 13) ? 'item' : 'items';
}

/** "block" texture folder (paired with the item folder). */
function blockFolderFor(folder) {
  return folder === 'item' ? 'block' : 'blocks';
}

/** True when an item name is a shulker box (which can hold items). */
function isShulkerName(name) {
  const n = String(name || '').toLowerCase();
  return n === 'shulker_box' || n.endsWith('_shulker_box');
}

/** "sharpness" → "Sharpness", "soul_speed" → "Soul Speed". */
function prettyName(name) {
  return String(name || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract enchantments from an item's NBT.
 * Modern versions store "Enchantments" (string ids); 1.8–1.12 store
 * "ench" (numeric ids). Registry maps both to pretty display names.
 * Returns [{ name, displayName, level }].
 */
function parseEnchants(nbt, registry) {
  const out = [];
  const tags = nbt && nbt.value;
  if (!tags) return out;

  // 'Enchantments' (1.13+), 'ench' (legacy), and 'StoredEnchantments'
  // (enchanted books store theirs here, same shape as Enchantments).
  for (const key of ['Enchantments', 'ench', 'StoredEnchantments']) {
    const listNode = tags[key];
    const items = listNode && listNode.value && Array.isArray(listNode.value.value) ? listNode.value.value : null;
    if (!items) continue;

    for (const comp of items) {
      const v = (comp && comp.value) || {};
      const idNode = v.id;
      if (!idNode || idNode.value === undefined) continue;

      let internalName = null;
      const raw = idNode.value;
      if (typeof raw === 'string') {
        internalName = raw.replace(/^minecraft:/, '');
      } else if (registry && registry.enchantments) {
        const def = registry.enchantments[raw];
        internalName = def && def.name;
      }
      if (!internalName) continue;

      const byName = registry && registry.enchantmentsByName && registry.enchantmentsByName[internalName];
      const displayName = byName && byName.displayName ? byName.displayName : prettyName(internalName);
      const lvlNode = v.lvl;
      out.push({
        name: internalName,
        displayName,
        level: lvlNode && lvlNode.value !== undefined ? Number(lvlNode.value) : 1
      });
    }
  }
  return out;
}

/**
 * Read the contents of a shulker box out of its item NBT
 * (BlockEntityTag.Items — a list of item compounds). Returns a
 * normalized array or null when the item holds no block-entity data.
 */
function parseShulkerContents(item, registry) {
  const tags = item && item.nbt && item.nbt.value;
  if (!tags) return null;
  const bet = tags.BlockEntityTag;
  const listNode = bet && bet.value && bet.value.Items;
  const list = listNode && listNode.value && Array.isArray(listNode.value.value) ? listNode.value.value : null;
  if (!list) return [];

  const out = [];
  for (const comp of list) {
    const v = (comp && comp.value) || {};
    const idNode = v.id;
    if (!idNode || idNode.value === undefined) continue;

    let def = null;
    if (typeof idNode.value === 'string') {
      const name = idNode.value.replace(/^minecraft:/, '');
      def = registry && registry.itemsByName && registry.itemsByName[name];
    } else if (registry && registry.items) {
      def = registry.items[idNode.value];
    }
    if (!def) continue;

    const countNode = v.Count;
    const slotNode = v.Slot;
    const dmgNode = v.Damage;
    const tag = v.tag;

    // Durability: 1.13+ keeps "Damage" inside the tag compound, older
    // versions use a top-level short — same shape as normalizeItem.
    let durabilityUsed = 0;
    if (dmgNode && dmgNode.value !== undefined) durabilityUsed = Number(dmgNode.value);
    else if (tag && tag.value && tag.value.Damage && tag.value.Damage.value !== undefined) {
      durabilityUsed = Number(tag.value.Damage.value);
    }
    const maxDurability = def.maxDurability || 0;

    out.push({
      name: def.name,
      displayName: def.displayName || prettyName(def.name),
      count: countNode && countNode.value !== undefined ? Number(countNode.value) : 1,
      slot: slotNode && slotNode.value !== undefined ? Number(slotNode.value) : null,
      metadata: dmgNode && dmgNode.value !== undefined ? Number(dmgNode.value) : 0,
      maxDurability,
      durability: maxDurability ? Math.max(0, maxDurability - durabilityUsed) : null,
      durabilityUsed,
      enchants: parseEnchants(tag, registry)
    });
  }
  return out;
}

/** Normalize one inventory item into a JSON-safe dashboard shape. */
function normalizeItem(item, registry, folder) {
  const type = item.type;
  const def = registry && registry.items && registry.items[type];
  const name = item.name || (def && def.name) || 'unknown';
  const displayName = item.displayName || (def && def.displayName) || prettyName(name);

  const maxDurability = def && def.maxDurability ? def.maxDurability : 0;
  const durabilityUsed = typeof item.durabilityUsed === 'number' ? item.durabilityUsed : 0;

  const foodDef = registry && registry.foods && registry.foods[type];

  return {
    slot: item.slot,
    type,
    name,
    displayName,
    count: item.count || 1,
    stackSize: (def && def.stackSize) || 64,
    metadata: item.metadata || 0,
    maxDurability,
    durability: maxDurability ? Math.max(0, maxDurability - durabilityUsed) : null,
    durabilityUsed,
    enchants: parseEnchants(item.nbt, registry),
    lore: Array.isArray(item.customLore) ? item.customLore : [],
    customName: item.customName || null,
    foodRestores: !!foodDef,
    foodPoints: foodDef && typeof foodDef.foodPoints === 'number' ? foodDef.foodPoints : null,
    isShulker: isShulkerName(name),
    shulker: isShulkerName(name) ? parseShulkerContents(item, registry) : null,
    folder
  };
}

/**
 * Build a full dashboard snapshot of the bot's inventory.
 * `items` = the 36 main slots (9 hotbar + 27 main), `armor` = 4 armor
 * slots (head/torso/legs/feet), `offhand` = slot 45 when present.
 * Returns null when the bot has no inventory yet.
 */
function buildInventorySnapshot(bot) {
  if (!bot || !bot.inventory) return null;
  const folder = textureFolderFor(bot.version);
  const registry = bot.registry;
  const norm = (item) => (item ? normalizeItem(item, registry, folder) : null);

  // Main inventory + hotbar only — armor (5–8) and offhand (45) are rendered
  // in their own sections, so exclude them here to keep the count honest.
  const items = (bot.inventory.items() || [])
    .filter((i) => i && i.slot >= 9 && i.slot <= 44)
    .map(norm)
    .filter(Boolean);
  const armor = [5, 6, 7, 8].map((slot) => norm(bot.inventory.slots[slot]));
  const offhand = norm(bot.inventory.slots[45]);

  // Experience: level + total points + progress (0..1) toward the next level.
  let experience = null;
  if (bot.experience && typeof bot.experience.level === 'number') {
    experience = {
      level: bot.experience.level,
      points: bot.experience.points || 0,
      progress: Math.max(0, Math.min(1, bot.experience.progress || 0))
    };
  }

  // Active potion effects on the bot (entity.effects keyed by numeric id,
  // duration in ticks). Names/colours come from the registry.
  const effects = [];
  const effMap = bot.entity && bot.entity.effects;
  if (effMap) {
    for (const key of Object.keys(effMap)) {
      const raw = effMap[key];
      if (!raw) continue;
      const def = registry && registry.effects && registry.effects[key];
      effects.push({
        id: Number(key),
        name: (def && def.name) || String(key),
        displayName: (def && def.displayName) || String(key),
        good: !(def && def.type === 'bad'),
        amplifier: (Number(raw.amplifier) || 0) + 1, // raw 0 == Level I
        durationSeconds: Number(raw.duration) > 0 ? Math.ceil(Number(raw.duration) / 20) : 0
      });
    }
    effects.sort((a, b) => (a.good === b.good ? a.displayName.localeCompare(b.displayName) : a.good ? -1 : 1));
  }

  return {
    version: bot.version,
    connected: true,
    folder,
    blockFolder: blockFolderFor(folder),
    items,
    armor,
    offhand,
    selectedSlot: typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : 0,
    health: Math.round(bot.health || 0),
    food: Math.round(bot.food || 0),
    foodSaturation: Math.round((bot.foodSaturation || 0) * 10) / 10,
    experience,
    effects
  };
}

module.exports = {
  buildInventorySnapshot,
  normalizeItem,
  parseEnchants,
  parseShulkerContents,
  textureFolderFor,
  blockFolderFor,
  isShulkerName,
  prettyName
};
