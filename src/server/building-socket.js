'use strict';

/* ============================================================
   Building — socket API
   ------------------------------------------------------------
   Client → server:
     building:list            -> manifest entries (any authed user)
     building:upload          -> store + parse a build file (admin)
     building:get             -> entry + parsed materials (any authed user)
     building:rename          -> rename a build (admin)
     building:delete          -> delete a build (admin)
     building:build           -> start building in-game (admin)
     building:stop            -> cancel the running build (admin)
     building:give            -> /give all materials to the bot (admin)

   Server → client:
     building:progress        -> live build progress stream
     building:updated         -> manifest changed (any client re-lists)
   ============================================================ */

const { parseBuild } = require('../building/parser');

function isAdmin(socket) {
  return socket.data && socket.data.user && socket.data.user.role === 'admin';
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

function extractErr(err) {
  if (!err) return 'Unknown error';
  return typeof err.message === 'string' && err.message.trim() ? err.message : String(err);
}

function registerBuildingSocketHandlers(io, store, builder) {
  // Push build progress to every connected dashboard client.
  builder.on('progress', (p) => io.emit('building:progress', p));

  const broadcastManifest = () => {
    io.emit('building:updated', { list: store.list() });
  };

  io.on('connection', (socket) => {
    // Fresh client — send the current library immediately.
    socket.emit('building:list', { ok: true, list: store.list() });

    socket.on('building:list', (data, ack) => {
      respond(ack, { ok: true, list: store.list() });
    });

    // Upload: { name, fileName, data: Buffer }
    socket.on('building:upload', async (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const buf = d.data;
      if (!(buf instanceof Buffer) || !buf.length) {
        return respond(ack, { ok: false, errors: ['No file received.'] });
      }
      if (buf.length > 30 * 1024 * 1024) {
        return respond(ack, { ok: false, errors: ['File is too large (max 30 MB).'] });
      }
      try {
        const parsed = await parseBuild(buf, d.fileName);
        const result = store.add({
          name: d.name,
          fileName: d.fileName,
          format: parsed.format,
          version: parsed.version,
          size: parsed.size,
          blockCount: parsed.blockCount,
          materialCount: parsed.materialCount,
          blockEntityCount: (parsed.blockEntities || []).length,
          entityCount: (parsed.entities || []).length,
          materials: parsed.materials,
          data: buf
        });
        if (!result.ok) return respond(ack, result);
        broadcastManifest();
        respond(ack, { ok: true, build: result.build, parsed });
      } catch (err) {
        respond(ack, { ok: false, errors: [extractErr(err)] });
      }
    });

    // Get one build: manifest entry + full materials (for the details panel).
    socket.on('building:get', (data, ack) => {
      const d = data && typeof data === 'object' ? data : {};
      const entry = store.get(d.id);
      if (!entry) return respond(ack, { ok: false, errors: ['Build not found.'] });
      respond(ack, { ok: true, build: { ...entry } });
    });

    // Get the parsed block data for the 3D preview (bounded so huge
    // schematics don't blow up the socket payload).
    socket.on('building:preview', async (data, ack) => {
      const d = data && typeof data === 'object' ? data : {};
      const entry = store.get(d.id);
      if (!entry) return respond(ack, { ok: false, errors: ['Build not found.'] });
      const buf = store.readFile(d.id);
      if (!buf) return respond(ack, { ok: false, errors: ['Build file is missing on disk.'] });
      try {
        const parsed = await parseBuild(buf, entry.fileName);
        const blocks = parsed.blocks || [];
        const MAX_PREVIEW = 120000;
        const truncated = blocks.length > MAX_PREVIEW;
        respond(ack, {
          ok: true,
          build: { ...entry },
          size: parsed.size,
          version: parsed.version,
          truncated,
          totalBlocks: blocks.length,
          blocks: truncated ? blocks.slice(0, MAX_PREVIEW) : blocks
        });
      } catch (err) {
        respond(ack, { ok: false, errors: [extractErr(err)] });
      }
    });

    socket.on('building:rename', (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = store.rename(d.id, d.name);
      if (!result.ok) return respond(ack, { ok: false, errors: result.errors });
      broadcastManifest();
      respond(ack, { ok: true, build: result.build });
    });

    socket.on('building:delete', (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = store.remove(d.id);
      if (!result.ok) return respond(ack, { ok: false, errors: result.errors });
      broadcastManifest();
      respond(ack, { ok: true });
    });

    // Start a build: { id, mode, origin, chest, speed, verify }
    socket.on('building:build', async (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = await builder.startBuild({
        id: d.id,
        mode: d.mode,
        origin: d.origin,
        chest: d.chest,
        speed: Number(d.speed),
        verify: d.verify
      });
      if (!result.ok) return respond(ack, { ok: false, errors: [result.error] });
      respond(ack, { ok: true });
    });

    socket.on('building:stop', (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      builder.stopBuild();
      respond(ack, { ok: true });
    });

    // Give all materials to the bot via /give (operator servers).
    socket.on('building:give', async (data, ack) => {
      if (!isAdmin(socket)) {
        return respond(ack, { ok: false, errors: ['Admin permission required.'] });
      }
      const d = data && typeof data === 'object' ? data : {};
      const result = await builder.giveItems(d.id);
      if (!result.ok) return respond(ack, { ok: false, errors: [result.error] });
      respond(ack, { ok: true, materials: result.materials });
    });
  });
}

module.exports = { registerBuildingSocketHandlers };
