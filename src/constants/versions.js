'use strict';

/**
 * Minecraft versions supported by Mineflayer, ordered oldest → newest.
 * This is the single source of truth for the version dropdown and for
 * server-side validation of the version field.
 *
 * The list is filtered at runtime against the installed `minecraft-data`
 * package, so only versions the bot can actually connect to are offered.
 */

const STATIC_VERSIONS = [
  '1.8.8',
  '1.8.9',
  '1.9.4',
  '1.10.2',
  '1.11.2',
  '1.12.2',
  '1.13.2',
  '1.14.4',
  '1.15.2',
  '1.16.1',
  '1.16.3',
  '1.16.4',
  '1.16.5',
  '1.17.1',
  '1.18.2',
  '1.19',
  '1.19.2',
  '1.19.3',
  '1.19.4',
  '1.20.1',
  '1.20.2',
  '1.20.3',
  '1.20.4',
  '1.20.5',
  '1.20.6',
  '1.21.1',
  '1.21.3',
  '1.21.4',
  '1.21.5',
  '1.21.6',
  '1.21.7',
  '1.21.8',
  '1.21.9',
  '1.21.10',
  '1.21.11'
];

let cached = null;

/** Versions the installed Mineflayer can actually connect to (oldest → newest). */
function getSupportedVersions() {
  if (cached) return cached;
  try {
    const minecraftData = require('minecraft-data');
    const pc = minecraftData.supportedVersions && minecraftData.supportedVersions.pc;
    if (Array.isArray(pc)) {
      cached = STATIC_VERSIONS.filter((v) => pc.includes(v));
    }
  } catch (_) {
    /* fall back to the static list */
  }
  cached = cached || STATIC_VERSIONS;
  return cached;
}

module.exports = { getSupportedVersions, STATIC_VERSIONS };
