'use strict';

/* ============================================================
   Building — persisted build library
   ------------------------------------------------------------
   Holds uploaded build files (.schematic / .litematic) plus a small
   manifest so the dashboard can list / search them without re-parsing.

   Layout (DATA_DIR-aware like every other store):
     <DATA_DIR>/builds.json            manifest (id -> metadata)
     <DATA_DIR>/builds/<id>.<ext>      the raw uploaded file

   On Render the DATA_DIR is ephemeral (same as users.json etc.), so an
   upload lasts for the life of the service instance — identical behaviour
   to the rest of the app's persisted state.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR)
  : path.join(__dirname, '..', '..');
const MANIFEST_PATH = path.join(BASE, 'builds.json');
const BUILDS_DIR = path.join(BASE, 'builds');

const MAX_BUILDS = 60;

let state = []; // [{ id, name, fileName, format, version, size, blockCount, materialCount, createdAt }]

function init() {
  try {
    fs.mkdirSync(BUILDS_DIR, { recursive: true });
  } catch (_) { /* ignore */ }
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      state = Array.isArray(raw) ? raw.filter((b) => b && typeof b.id === 'string') : [];
    } catch (_) {
      state = [];
    }
  }
  return list();
}

function persist() {
  try {
    fs.mkdirSync(BUILDS_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error(`[building] Could not write builds.json (${err.message}).`);
  }
}

/** Manifest entries sorted newest-first (safe to send to clients). */
function list() {
  return state
    .map((b) => ({ ...b }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** One manifest entry by id (or null). */
function get(id) {
  return state.find((b) => b.id === id) || null;
}

/** Raw file path for a build id (null when missing). */
function filePath(id) {
  const b = get(id);
  if (!b) return null;
  const ext = b.format === 'litematic' ? 'litematic' : 'schem';
  return path.join(BUILDS_DIR, `${b.id}.${ext}`);
}

/** Read the raw uploaded file for a build id (null when missing). */
function readFile(id) {
  const p = filePath(id);
  if (!p || !fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p);
  } catch (_) {
    return null;
  }
}

/** Add a build. `data` is the raw buffer. Returns { ok, build } or { ok:false, errors }. */
function add({ name, fileName, format, version, size, blockCount, materialCount, blockEntityCount, entityCount, materials, data }) {
  const errors = [];
  const cleanName = String(name || '').trim().replace(/[^\w \-.]/g, '').slice(0, 60);
  if (!cleanName) errors.push('Give the build a name.');
  if (!format || !['schematic', 'litematic'].includes(format)) errors.push('Unsupported file format.');
  if (!(data instanceof Buffer) || !data.length) errors.push('The file is empty.');
  if (state.length >= MAX_BUILDS) errors.push(`Build library is full (max ${MAX_BUILDS}). Delete one first.`);
  if (errors.length) return { ok: false, errors };

  const id = crypto.randomBytes(6).toString('hex');
  const entry = {
    id,
    name: cleanName,
    fileName: String(fileName || '').slice(0, 120),
    format,
    version: String(version || ''),
    size: { x: Number(size && size.x) || 0, y: Number(size && size.y) || 0, z: Number(size && size.z) || 0 },
    blockCount: Number(blockCount) || 0,
    materialCount: Number(materialCount) || 0,
    blockEntityCount: Number(blockEntityCount) || 0,
    entityCount: Number(entityCount) || 0,
    materials: Array.isArray(materials) ? materials.map((m) => ({ name: String(m.name), count: Number(m.count) || 0 })) : [],
    createdAt: new Date().toISOString()
  };

  try {
    fs.mkdirSync(BUILDS_DIR, { recursive: true });
    const ext = format === 'litematic' ? 'litematic' : 'schem';
    fs.writeFileSync(path.join(BUILDS_DIR, `${id}.${ext}`), data);
  } catch (err) {
    return { ok: false, errors: [`Could not store the file (${err.message}).`] };
  }

  state.push(entry);
  persist();
  return { ok: true, build: { ...entry } };
}

/** Rename a build. Returns { ok, build } or { ok:false, errors }. */
function rename(id, name) {
  const b = get(id);
  if (!b) return { ok: false, errors: ['Build not found.'] };
  const cleanName = String(name || '').trim().replace(/[^\w \-.]/g, '').slice(0, 60);
  if (!cleanName) return { ok: false, errors: ['Name cannot be empty.'] };
  b.name = cleanName;
  persist();
  return { ok: true, build: { ...b } };
}

/** Delete a build (file + manifest entry). */
function remove(id) {
  const b = get(id);
  if (!b) return { ok: false, errors: ['Build not found.'] };
  try {
    const p = filePath(id);
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  } catch (_) { /* ignore */ }
  state = state.filter((x) => x.id !== id);
  persist();
  return { ok: true };
}

module.exports = { init, list, get, add, rename, remove, readFile, filePath, MAX_BUILDS };
