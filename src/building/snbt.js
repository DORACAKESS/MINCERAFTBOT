'use strict';

/* ============================================================
   Building — SNBT serializer
   ------------------------------------------------------------
   Converts prismarine-nbt tag structures ({ type, value }) into
   Minecraft SNBT (Stringified NBT) — the syntax used inside
   /setblock … {nbt}, /summon … {nbt} and /data modify commands.

   Supports the tag types prismarine-nbt can hand us: byte, short,
   int, long, float, double, string, byteArray, intArray, longArray,
   list and compound. Longs may arrive as BigInt, [low, high] pairs,
   {low, high} objects or plain numbers — all are normalized.

   Pure + exported so the serialization is unit-testable.
   ============================================================ */

function snbt(tag) {
  if (tag === null || tag === undefined) return '';
  if (typeof tag === 'number' || typeof tag === 'string' || typeof tag === 'boolean' || typeof tag === 'bigint') {
    // Bare value (from a simplified tree) — wrap as the closest SNBT type.
    return typeof tag === 'string' ? quote(tag) : String(tag);
  }
  if (Array.isArray(tag)) return '[' + tag.map(snbt).join(',') + ']';
  const type = tag.type;
  const value = tag.value;
  switch (type) {
    case 'byte': return String(value) + 'b';
    case 'short': return String(value) + 's';
    case 'int': return String(value);
    case 'long': return longToSnbt(value);
    case 'float': return Number(value) + 'f';
    case 'double': return Number(value) + 'd';
    case 'string': return quote(String(value));
    case 'byteArray': return '[B;' + (Array.isArray(value) ? value.join(',') : '') + ']';
    case 'intArray': return '[I;' + (Array.isArray(value) ? value.join(',') : '') + ']';
    case 'longArray': return '[L;' + (Array.isArray(value) ? value.map(longToSnbt).join(',') : '') + ']';
    case 'list': {
      const inner = value && value.value !== undefined ? value.value : value;
      return '[' + (Array.isArray(inner) ? inner.map(snbt).join(',') : '') + ']';
    }
    case 'compound': {
      const obj = value && typeof value === 'object' ? value : {};
      const parts = [];
      for (const [k, v] of Object.entries(obj)) {
        const s = snbt(v);
        if (s === '' || s === undefined) continue;
        parts.push(String(k) + ':' + s);
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      return '';
  }
}

/** SNBT string quoting — the value is a JSON-encoded text component string. */
function quote(s) {
  return JSON.stringify(String(s));
}

/** Normalize a long tag value (BigInt | [lo,hi] | {low,high} | number | bigint-string). */
function longToSnbt(v) {
  let big;
  if (typeof v === 'bigint') big = v;
  else if (Array.isArray(v)) {
    const low = BigInt.asUintN(32, BigInt(v[0] >>> 0));
    const high = BigInt.asUintN(32, BigInt(v[1] >>> 0));
    big = (high << 32n) | low;
    // prismarine-nbt stores longs as signed 64-bit — reinterpret as signed.
    if (big >= 0x8000000000000000n) big -= 0x10000000000000000n;
  } else if (v && typeof v === 'object' && typeof v.low === 'number') {
    const low = BigInt.asUintN(32, BigInt(v.low >>> 0));
    const high = BigInt.asUintN(32, BigInt(v.high >>> 0));
    big = (high << 32n) | low;
    if (big >= 0x8000000000000000n) big -= 0x10000000000000000n;
  } else {
    big = BigInt(v);
  }
  return big.toString() + 'L';
}

/**
 * Build a /setblock command with exact block state + optional block-entity NBT:
 *   /setblock 10 64 10 oak_stairs[facing=east] {front_text:{messages:["…"]}}
 * `block` = { name, properties?, blockEntity? } — blockEntity is a prismarine-nbt
 * tag (usually a compound). Returns the command string (or null when the block
 * is not placeable by command).
 */
function setblockCommand(block, origin) {
  if (!block || !block.name) return null;
  const name = String(block.name).replace(/^minecraft:/, '');
  const state = blockDescriptor(block.name, block.properties);
  const x = origin.x + (block.x || 0);
  const y = origin.y + (block.y || 0);
  const z = origin.z + (block.z || 0);
  let cmd = `/setblock ${x} ${y} ${z} ${state}`;
  if (block.blockEntity) {
    const n = snbt(block.blockEntity);
    if (n) cmd += ' ' + n;
  }
  return cmd;
}

/** Shared block-state descriptor: name[prop=val,...] (see builder.js). */
function blockDescriptor(name, properties) {
  const clean = String(name || 'unknown').replace(/^minecraft:/, '');
  const props = properties && typeof properties === 'object' ? properties : null;
  if (!props) return clean;
  const parts = [];
  for (const k of Object.keys(props).sort()) {
    const v = props[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${v}`);
  }
  return parts.length ? `${clean}[${parts.join(',')}]` : clean;
}

module.exports = { snbt, setblockCommand, blockDescriptor, longToSnbt };
