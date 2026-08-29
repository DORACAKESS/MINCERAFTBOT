'use strict';

/* ============================================================
   Building — schematic / litematic parser
   ------------------------------------------------------------
   Turns an uploaded build file into a JSON-safe shape the dashboard
   and the builder engine can both use:

     {
       format:    'schematic' | 'litematic' | 'unknown',
       version:   mc version string when known (e.g. '1.16.4'),
       size:      { x, y, z },            // bounding box (blocks)
       blockCount,                        // non-air blocks
       materials: [ { name, count } ],    // block name -> count (air excluded)
       blocks:    [ { x, y, z, name } ]   // every non-air block, relative to 0,0,0
     }

   Supported files:
     - .schem / .schematic  → Sponge (read/write) + MCEdit (read-only)
                              via prismarine-schematic
     - .litematic           → Litematica NBT (custom bit-packed decoder,
                              no extra dependency — prismarine-nbt handles
                              the NBT, we decode the BlockStates long array)

   The litematic decoder is pure + exported so the bit-packing math is
   unit-testable without a real file.
   ============================================================ */

const nbt = require('prismarine-nbt');

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** Blocks a survival bot can't hold/place as items (kept out of materials). */
const SKIP_NAMES = new Set([
  'water', 'flowing_water', 'lava', 'flowing_lava',
  'air', 'cave_air', 'void_air', 'structure_void'
]);

/** Lower-case a block name, stripping any minecraft: prefix. */
function cleanName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '');
}

/** True when the file extension looks like a supported build file. */
function isBuildFile(fileName) {
  const n = String(fileName || '').toLowerCase();
  return /\.(schem|schematic|litematic)$/.test(n);
}

/** Format tag for a file name ('' when unsupported). */
function formatFor(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (n.endsWith('.litematic')) return 'litematic';
  if (n.endsWith('.schem') || n.endsWith('.schematic')) return 'schematic';
  return 'unknown';
}

/** Turn a raw {x,y,z} (numbers or strings) into a numbers object. */
function vec(v, dx = 0, dy = 0, dz = 0) {
  return {
    x: Number(v && v.x) + dx || 0,
    y: Number(v && v.y) + dy || 0,
    z: Number(v && v.z) + dz || 0
  };
}

/**
 * Normalize a per-block list + palette into the shared output shape.
 * `blockRefs` entries: { x, y, z, name } (name already cleaned).
 * Optional `blockEntities` (list of { x, y, z, id, data }) and `entities`
 * (list of { x, y, z, id, data }) are carried through when provided.
 */
function summarize(format, version, size, blockRefs, blockEntities, entities) {
  const counts = new Map();
  for (const b of blockRefs) {
    // Water/lava/structure_void can't be held or /give-n as items — keep
    // them OUT of the materials list (and out of what gets built) so the
    // UI never shows "water × 20" or issues an invalid /give.
    if (AIR_NAMES.has(b.name) || SKIP_NAMES.has(b.name)) continue;
    counts.set(b.name, (counts.get(b.name) || 0) + 1);
  }
  const materials = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const blocks = blockRefs.filter((b) => !AIR_NAMES.has(b.name) && !SKIP_NAMES.has(b.name));
  const out = {
    format,
    version,
    size: { x: size.x, y: size.y, z: size.z },
    blockCount: blocks.length,
    materialCount: materials.length,
    materials,
    blocks
  };
  if (blockEntities && blockEntities.length) out.blockEntities = blockEntities;
  if (entities && entities.length) out.entities = entities;
  return out;
}

/* ============================================================
   .schematic / .schem (prismarine-schematic)
   ============================================================ */

/** Parse a .schem / .schematic buffer. Returns the normalized shape. */
async function parseSchematic(buffer) {
  const { Schematic } = require('prismarine-schematic');
  const schem = await Schematic.read(buffer);
  const size = vec(schem.size);
  const blockRefs = [];
  await schem.forEach((block, pos) => {
    if (!block) return;
    const name = cleanName(block.name || 'unknown');
    // forEach iterates start..end (offset-aware); use positions relative
    // to the schematic origin (0,0,0) so builders can offset freely.
    const ref = { x: pos.x - (schem.offset.x || 0), y: pos.y - (schem.offset.y || 0), z: pos.z - (schem.offset.z || 0), name };
    // Preserve exact block states (facing / half / axis / open …) so the
    // builder can place them precisely (operator /setblock, creative exact
    // placement) instead of relying on physics defaults.
    const props = typeof block.getProperties === 'function' ? block.getProperties() : (block.properties || null);
    if (props && Object.keys(props).length) ref.properties = props;
    blockRefs.push(ref);
  });
  const version = String(schem.version || '');
  // Block entities (sign text, chest contents, banner patterns …) and
  // entities (paintings, item frames, armor stands) live in the same NBT
  // but prismarine-schematic ignores them — read them from the raw tags.
  const { blockEntities, entities } = await extractSchematicExtras(buffer, schem);
  return summarize('schematic', version, size, blockRefs, blockEntities, entities);
}

/**
 * Pull BlockEntities + Entities out of a Sponge/MCEdit schematic's raw NBT.
 * Block entity Pos is ABSOLUTE (block coords = Pos + offset), so we normalize
 * to the same origin-relative space as the block list (pos - offset).
 * Returns { blockEntities: [{x,y,z,id,data}], entities: [{x,y,z,id,data}] }.
 */
async function extractSchematicExtras(buffer, schem) {
  const nbt = require('prismarine-nbt');
  try {
    const { parsed } = await nbt.parse(buffer);
    // BlockEntity/Entity positions are stored in the SAME origin-relative
    // space as the normalized block list (array index space) — no offset
    // shift needed.
    return finishExtract(parsed);
  } catch (_) {
    return { blockEntities: [], entities: [] };
  }
}

/** Shared extra extraction (works on the parsed tag root). */
function finishExtract(parsed) {
  const root = parsed && parsed.value ? parsed.value : {};
  const blockEntities = [];
  const entities = [];

  const listArr = (node) => node && node.value && Array.isArray(node.value.value) ? node.value.value : [];

  // prismarine-nbt hands list-of-compound items back FLAT ({key: tag} — no
  // {type:'compound', value:…} wrapper), so unwrap both shapes defensively.
  const unwrap = (x) => (x && typeof x === 'object' && x.type === 'compound' && x.value ? x.value : x || {});

  // Sponge v2: BlockEntities = [{ Id, Pos: int[], ...nbt }]; Entities = [{ Id, Pos: double[], ...nbt }]
  for (const be of listArr(root.BlockEntities)) {
    const v = unwrap(be);
    const id = String((v.Id && v.Id.value) || '');
    const pos = (v.Pos && v.Pos.value) || [];
    if (!id || pos.length < 3) continue;
    blockEntities.push({
      x: Math.round(Number(pos[0])),
      y: Math.round(Number(pos[1])),
      z: Math.round(Number(pos[2])),
      id,
      data: stripKeys(be, ['Id', 'Pos'])
    });
  }
  // MCEdit: TileEntities = [{ id, x, y, z, ...nbt }]
  for (const te of listArr(root.TileEntities)) {
    const v = unwrap(te);
    const id = String((v.id && v.id.value) || (v.Id && v.Id.value) || '');
    if (!id || v.x === undefined || v.y === undefined || v.z === undefined) continue;
    const coord = (n) => (n && typeof n === 'object' && 'value' in n ? Number(n.value) : Number(n));
    blockEntities.push({
      x: Math.round(coord(v.x)),
      y: Math.round(coord(v.y)),
      z: Math.round(coord(v.z)),
      id,
      data: stripKeys(te, ['id', 'Id', 'x', 'y', 'z', 'X', 'Y', 'Z'])
    });
  }
  // Entities (sponge v2): Pos is doubles (block-centre +0.5).
  for (const en of listArr(root.Entities)) {
    const v = unwrap(en);
    const id = String((v.Id && v.Id.value) || '');
    const pos = (v.Pos && v.Pos.value) || [];
    if (!id || pos.length < 3) continue;
    entities.push({
      x: Number(pos[0]),
      y: Number(pos[1]),
      z: Number(pos[2]),
      id,
      data: stripKeys(en, ['Id', 'Pos'])
    });
  }
  return { blockEntities, entities };
}

/** Clone a compound tag without the given keys (position/identity fields).
    Accepts wrapped ({type,value}) or flat ({key: tag}) compounds. */
function stripKeys(tag, keys) {
  let obj = tag;
  if (tag && tag.type === 'compound' && tag.value && typeof tag.value === 'object') obj = tag.value;
  if (!obj || typeof obj !== 'object') return { type: 'compound', value: {} };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(k)) continue;
    out[k] = v;
  }
  return { type: 'compound', value: out };
}

/* ============================================================
   .litematic (custom decoder)
   ============================================================ */

/**
 * Decode a Minecraft-style packed long array (the litematic BlockStates
 * field) into block-state indices.
 *
 *   longs       — the raw long array as produced by prismarine-nbt, i.e.
 *                 an array of 64-bit values. Each value may be a BigInt,
 *                 a JS number, or a prismarine-nbt long pair [low, high].
 *   bitsPer     — bits per entry (max(2, ceil(log2(paletteSize))))
 *   count       — number of entries to decode
 *
 * Bits are packed least-significant-bit-first across 64-bit words (the
 * same layout Minecraft uses for chunk section palettes). Values may span
 * a word boundary, so each read stitches up to two words together.
 * Pure + exported for unit tests.
 */
function decodeBlockStates(longs, bitsPer, count) {
  const words = longs.map(toWord64);
  const mask = bitsPer >= 64 ? 0xffffffffffffffffn : ((1n << BigInt(bitsPer)) - 1n);
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const bitIndex = BigInt(i) * BigInt(bitsPer);
    const wordIndex = Number(bitIndex >> 6n);
    const bitOffset = Number(bitIndex & 63n);
    let value = words[wordIndex] >> BigInt(bitOffset);
    if (wordIndex + 1 < words.length && bitOffset + bitsPer > 64) {
      // Entry spans into the next word.
      value |= words[wordIndex + 1] << BigInt(64 - bitOffset);
    }
    out[i] = Number(value & mask);
  }
  return out;
}

/** Normalize one long-array element to an unsigned 64-bit BigInt. */
function toWord64(v) {
  if (typeof v === 'bigint') return BigInt.asUintN(64, v);
  if (Array.isArray(v)) {
    // prismarine-nbt represents long values as signed [low, high] pairs.
    const low = BigInt.asUintN(32, BigInt(v[0] >>> 0));
    const high = BigInt.asUintN(32, BigInt(v[1] >>> 0));
    return (high << 32n) | low;
  }
  if (typeof v === 'number') return BigInt.asUintN(64, BigInt(v));
  // Object with .low/.high (protobufjs-style Long)
  if (v && typeof v === 'object' && typeof v.low === 'number') {
    const low = BigInt.asUintN(32, BigInt(v.low >>> 0));
    const high = BigInt.asUintN(32, BigInt(v.high >>> 0));
    return (high << 32n) | low;
  }
  return 0n;
}

/** Smallest bits-per-block that can address `paletteSize` entries (min 2). */
function bitsPerFor(paletteSize) {
  return Math.max(2, Math.ceil(Math.log2(Math.max(1, paletteSize))));
}

/**
 * Parse a .litematic buffer.
 * Litematica NBT layout:
 *   root.Regions.<name>.Position            [x,y,z] region offset
 *   root.Regions.<name>.Size                [x,y,z] region size
 *   root.Regions.<name>.BlockStatePalette   list of { Name, Properties? }
 *   root.Regions.<name>.BlockStates         packed long array
 *   root.Regions.<name>.BlockEntityData     list of { pos, data } (block NBT)
 *   root.Regions.<name>.Entities            list of { pos, data } (entity NBT)
 * Returns the normalized shape (materials across ALL regions).
 */
async function parseLitematic(buffer) {
  const { parsed } = await nbt.parse(buffer);
  return litematicFromParsed(parsed);
}

/**
 * Same as parseLitematic but takes the already-parsed NBT structure (the
 * { parsed } object from prismarine-nbt) — exported so the region decoding
 * logic is unit-testable without an on-disk file.
 */
function litematicFromParsed(parsed) {
  const root = parsed && parsed.value ? parsed.value : {};
  const regions = root.Regions && root.Regions.value ? root.Regions.value : {};
  const blockRefs = [];
  let version = '';

  // Version is stored at root; for textures we only need it roughly.
  try {
    const v = root.Version && root.Version.value;
    if (typeof v === 'number' && v > 0) version = `litematic-v${v}`;
  } catch (_) { /* ignore */ }

  const blockEntities = [];
  const entities = [];

  for (const regionName of Object.keys(regions)) {
    const region = regions[regionName];
    if (!region || !region.value) continue;
    const rv = region.value;
    // prismarine-nbt nests list arrays under { type, value: { type, value: [...] } }
    const listArr = (node) => node && node.value && Array.isArray(node.value.value) ? node.value.value : [];
    const pos = listArr(rv.Position);
    const size = listArr(rv.Size);
    const paletteRaw = listArr(rv.BlockStatePalette);
    // Each palette entry carries Name + an optional Properties compound
    // (facing / half / axis …) — keep them so placement is exact.
    const palette = paletteRaw
      .map((p) => {
        const pv = p && p.value;
        const name = cleanName(pv && pv.Name && pv.Name.value);
        const props = {};
        if (pv && pv.Properties && pv.Properties.value) {
          for (const [k, node] of Object.entries(pv.Properties.value)) {
            const v = node && node.value;
            if (v !== undefined && v !== null) props[k] = String(v);
          }
        }
        return { name: name || 'unknown', properties: props };
      })
      .filter((p) => p.name);
    if (!palette.length || !size || !size.length) continue;

    const w = Number(size[0]) || 0;
    const h = Number(size[1]) || 0;
    const d = Number(size[2]) || 0;
    const ox = Number(pos[0]) || 0;
    const oy = Number(pos[1]) || 0;
    const oz = Number(pos[2]) || 0;
    const bpb = bitsPerFor(palette.length);
    const count = w * h * d;

    const statesNode = rv.BlockStates;
    const rawLongs = statesNode && statesNode.value ? statesNode.value : [];
    const indices = decodeBlockStates(rawLongs, bpb, count);

    let i = 0;
    for (let y = 0; y < h; y++) {
      for (let z = 0; z < d; z++) {
        for (let x = 0; x < w; x++) {
          const pi = indices[i++];
          const entry = pi !== undefined && palette[pi] ? palette[pi] : { name: 'air', properties: {} };
          const ref = { x: x + ox, y: y + oy, z: z + oz, name: entry.name };
          if (entry.properties && Object.keys(entry.properties).length) ref.properties = entry.properties;
          blockRefs.push(ref);
        }
      }
    }

    // Block entity NBT: { pos: [x,y,z] (region-relative), data: compound }.
    for (const bed of listArr(rv.BlockEntityData)) {
      if (!bed || !bed.value) continue;
      const bv = bed.value;
      const bpos = (bv.pos && bv.pos.value) || [];
      const data = bv.data || null;
      if (bpos.length < 3 || !data) continue;
      const id = String((data.value && data.value.id && data.value.id.value) || (data.value && data.value.Id && data.value.Id.value) || 'minecraft:unknown');
      blockEntities.push({
        x: Number(bpos[0]) + ox,
        y: Number(bpos[1]) + oy,
        z: Number(bpos[2]) + oz,
        id,
        data
      });
    }
    // Entities: { pos: [x,y,z], data: compound (Id, Pos …) }.
    for (const en of listArr(rv.Entities)) {
      if (!en || !en.value) continue;
      const ev = en.value;
      const epos = (ev.pos && ev.pos.value) || [];
      const data = ev.data || null;
      if (epos.length < 3 || !data) continue;
      const id = String((data.value && data.value.Id && data.value.Id.value) || (data.value && data.value.id && data.value.id.value) || 'minecraft:unknown');
      entities.push({
        x: Number(epos[0]) + ox,
        y: Number(epos[1]) + oy,
        z: Number(epos[2]) + oz,
        id,
        data
      });
    }
  }

  if (!blockRefs.length) throw new Error('No regions found in the .litematic file.');
  // The bounding size is the union of all regions (relative to origin 0).
  const xs = blockRefs.map((b) => b.x);
  const ys = blockRefs.map((b) => b.y);
  const zs = blockRefs.map((b) => b.z);
  const size = {
    x: Math.max(0, ...xs) - Math.min(0, ...xs) + 1,
    y: Math.max(0, ...ys) - Math.min(0, ...ys) + 1,
    z: Math.max(0, ...zs) - Math.min(0, ...zs) + 1
  };
  return summarize('litematic', version, size, blockRefs, blockEntities, entities);
}

/**
 * Parse any supported build buffer. Throws a friendly error for
 * unsupported/empty files.
 */
async function parseBuild(buffer, fileName) {
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer || []);
  if (!buf.length) throw new Error('The file is empty.');
  const format = formatFor(fileName);
  if (format === 'schematic') return parseSchematic(buf);
  if (format === 'litematic') return parseLitematic(buf);
  throw new Error('Unsupported file type — use .schematic, .schem or .litematic.');
}

module.exports = {
  parseBuild,
  parseSchematic,
  parseLitematic,
  litematicFromParsed,
  decodeBlockStates,
  bitsPerFor,
  toWord64,
  cleanName,
  isBuildFile,
  formatFor,
  extractSchematicExtras,
  AIR_NAMES,
  SKIP_NAMES
};
