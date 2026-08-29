'use strict';

/* ============================================================
   MineBot — AI admin REST routes (keys + settings)
   All routes require an admin session (role enforced here).
   ============================================================ */

const providers = require('../ai/providers');

function registerAIRoutes(app, { keysStore, settingsStore, isAdmin }) {
  const adminOnly = (req, res, next) => {
    if (isAdmin(req)) return next();
    return res.status(403).json({ ok: false, error: 'Admin permission required.' });
  };

  app.get('/api/ai/keys', adminOnly, (req, res) => {
    res.json({ ok: true, keys: keysStore.list() });
  });

  app.post('/api/ai/keys', adminOnly, (req, res) => {
    const result = keysStore.add(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, key: result.key });
  });

  app.put('/api/ai/keys/:name', adminOnly, (req, res) => {
    const result = keysStore.update(req.params.name, req.body || {});
    if (!result.ok) return res.status(result.error === 'Key not found.' ? 404 : 400).json(result);
    res.json({ ok: true, key: result.key });
  });

  app.delete('/api/ai/keys/:name', adminOnly, (req, res) => {
    const result = keysStore.remove(req.params.name);
    if (!result.ok) return res.status(404).json(result);
    res.json({ ok: true });
  });

  app.post('/api/ai/keys/:name/test', adminOnly, async (req, res) => {
    const key = keysStore.byName(req.params.name);
    if (!key) return res.status(404).json({ ok: false, error: 'Key not found.' });
    const t0 = Date.now();
    try {
      await providers.chat({
        provider: key.provider,
        apiKey: key.apiKey,
        model: key.model,
        endpoint: key.endpoint,
        systemPrompt: 'Reply with exactly: OK',
        messages: [{ role: 'user', content: 'ping' }],
        maxOutputTokens: 16
      });
      res.json({ ok: true, latencyMs: Date.now() - t0, model: key.model, provider: key.provider });
    } catch (err) {
      res.json({ ok: false, latencyMs: Date.now() - t0, error: err && err.message ? err.message : String(err) });
    }
  });

  app.get('/api/ai/settings', adminOnly, (req, res) => {
    res.json({ ok: true, settings: settingsStore.get() });
  });

  app.put('/api/ai/settings', adminOnly, (req, res) => {
    const result = settingsStore.save(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json({ ok: true, settings: result.settings });
  });
}

module.exports = { registerAIRoutes };
