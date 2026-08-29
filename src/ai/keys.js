'use strict';

/* ============================================================
   MineBot — AI key store
   Persists saved AI provider keys to ai-keys.json (gitignored).
   Multiple keys allowed; names must be unique (case-insensitive).
   ============================================================ */

const fs = require('fs');
const path = require('path');

// DATA_DIR lets tests run against a throwaway directory so the user's real
// ai-keys.json is never touched. Falls back to the project root when unset.
const KEYS_FILE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'ai-keys.json')
  : path.join(__dirname, '..', '..', 'ai-keys.json');

const PROVIDERS = ['gemini', 'groq', 'nvidia', 'custom'];

// Best CURRENT free models — verified against provider docs (July 2026) and
// the live NVIDIA NIM model catalog (https://integrate.api.nvidia.com/v1/models):
//  - Gemini free tier: gemini-3.6-flash (latest stable flash)
//  - Groq:             llama-3.3-70b-versatile (production, 131k context)
//  - NVIDIA NIM:       meta/llama-3.3-70b-instruct (free tier, 128k context,
//                      verified live on the NIM API — fast and reliable)
//  - Custom:           user-supplied endpoint/model
const DEFAULT_MODELS = { gemini: 'gemini-3.6-flash', groq: 'llama-3.3-70b-versatile', nvidia: 'meta/llama-3.3-70b-instruct', custom: '' };

const DEFAULT_TOKENS = { maxInputTokens: 131072, maxOutputTokens: 8192 };

// Per-provider output caps: NVIDIA NIM's free tier limits llama-3.3-70b
// replies to 4,096 tokens — keys saved without an explicit output limit
// (e.g. via the API) must not default to 8192 or the Test button fails.
const PROVIDER_OUTPUT_DEFAULT = { gemini: 8192, groq: 8192, nvidia: 4096, custom: 8192 };

// keys: [{ id, name, provider, apiKey, model, endpoint, maxInputTokens, maxOutputTokens, createdAt, updatedAt }]
let keys = [];

function init() {
  if (fs.existsSync(KEYS_FILE)) {
    try {
      keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch (_) {
      keys = [];
    }
  } else {
    keys = [];
  }
  return keys;
}

function save() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), 'utf8');
}

function list() {
  return [...keys];
}

function byName(name) {
  const n = String(name || '').trim().toLowerCase();
  return keys.find((k) => k.name.toLowerCase() === n) || null;
}

function byId(id) {
  return keys.find((k) => k.id === id) || null;
}

function normalize(input) {
  const inpTok = Number(input.maxInputTokens);
  const outTok = Number(input.maxOutputTokens);
  return {
    name: String(input.name || '').trim(),
    provider: String(input.provider || '').trim().toLowerCase(),
    apiKey: String(input.apiKey || '').trim(),
    model: String(input.model || '').trim(),
    endpoint: String(input.endpoint || '').trim(),
    // Missing/invalid token values fall back to sensible defaults (input is
    // provider-agnostic; output respects the provider's reply cap).
    maxInputTokens: Number.isFinite(inpTok) && inpTok >= 1 ? Math.floor(inpTok) : DEFAULT_TOKENS.maxInputTokens,
    maxOutputTokens: Number.isFinite(outTok) && outTok >= 1
      ? Math.floor(outTok)
      : (PROVIDER_OUTPUT_DEFAULT[String(input.provider || '').toLowerCase()] || DEFAULT_TOKENS.maxOutputTokens)
  };
}

function validate(input, existingName) {
  const errors = [];
  const v = normalize(input);

  if (v.name.length < 1 || v.name.length > 32) {
    errors.push('Name must be 1–32 characters.');
  } else if (keys.some((k) => k.name.toLowerCase() === v.name.toLowerCase() && k.name !== existingName)) {
    errors.push(`An AI key named "${v.name}" already exists — names must be unique.`);
  }

  if (!PROVIDERS.includes(v.provider)) errors.push('Provider must be gemini, groq, nvidia or custom.');
  if (!v.apiKey) errors.push('API key is required.');
  if (!v.model) errors.push('Model is required (e.g. gemini-3.6-flash, llama-3.3-70b-versatile, meta/llama-3.3-70b-instruct).');
  if (v.provider === 'custom' && !/^https?:\/\//i.test(v.endpoint)) {
    errors.push('Custom provider needs a full endpoint URL (https://…).');
  }
  if (!Number.isInteger(v.maxInputTokens) || v.maxInputTokens < 1 || v.maxInputTokens > 2000000) {
    errors.push('Input tokens must be a number between 1 and 2,000,000.');
  }
  if (!Number.isInteger(v.maxOutputTokens) || v.maxOutputTokens < 1 || v.maxOutputTokens > 200000) {
    errors.push('Output tokens must be a number between 1 and 200,000.');
  }

  return { ok: errors.length === 0, errors, value: v };
}

function add(input) {
  const r = validate(input);
  if (!r.ok) return r;
  const now = new Date().toISOString();
  const key = {
    id: 'k_' + Math.random().toString(36).slice(2, 10),
    ...r.value,
    createdAt: now,
    updatedAt: now
  };
  keys.push(key);
  save();
  return { ok: true, key };
}

function update(name, input) {
  const existing = byName(name);
  if (!existing) return { ok: false, error: 'Key not found.' };
  const r = validate({ ...existing, ...input }, existing.name);
  if (!r.ok) return r;
  Object.assign(existing, r.value, { updatedAt: new Date().toISOString() });
  save();
  return { ok: true, key: existing };
}

function remove(name) {
  const before = keys.length;
  keys = keys.filter((k) => k.name.toLowerCase() !== String(name || '').trim().toLowerCase());
  if (keys.length === before) return { ok: false, error: 'Key not found.' };
  save();
  return { ok: true };
}

module.exports = { init, list, byName, byId, add, update, remove, PROVIDERS, DEFAULT_MODELS, DEFAULT_TOKENS, PROVIDER_OUTPUT_DEFAULT };
