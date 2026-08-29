'use strict';

/* ============================================================
   MineBot — AI provider adapters
   Calls the Gemini, Groq and Custom (OpenAI-compatible) APIs
   using plain fetch (Node 18+). Supports one-shot AND streaming
   (onChunk) responses via SSE parsing.
   ============================================================ */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const GROQ_BASE = 'https://api.groq.com/openai/v1';
const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1';

const REQUEST_TIMEOUT_MS = 90000;

/**
 * Create an AbortController wired to BOTH the hard 90s timeout and an
 * optional external signal (the engine's "Stop generating" cancel). When
 * the external signal aborts first, the caller knows via signal.aborted
 * that it was a user cancel (not a timeout).
 */
function withTimeout(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return { controller, timer };
}

function errorFromResponse(data, status) {
  return (
    (data && data.error && (data.error.message || data.error)) ||
    (data && data.message) ||
    `HTTP ${status}`
  );
}

/** Parse an SSE stream: calls onData(payload) for every `data:` line. */
async function streamSSE(response, onData) {
  if (!response || !response.body) throw new Error('No response body from the provider.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload) onData(payload);
    }
  }
  const rest = buffer.trim();
  if (rest && rest.startsWith('data:')) onData(rest.slice(5).trim());
}

async function gemini({ apiKey, model, systemPrompt, messages, maxOutputTokens, signal }) {
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const { controller, timer } = withTimeout(signal);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: Number(maxOutputTokens) || 8192 }
      })
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(String(errorFromResponse(data, res.status)).slice(0, 300));
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    if (!parts || !parts.length) throw new Error('No content in the model response (it may have been blocked).');
    return parts.map((p) => p.text || '').join('').trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) throw new Error('CANCELLED'); // user pressed Stop
      throw new Error('Request timed out (90s).');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function geminiStream({ apiKey, model, systemPrompt, messages, maxOutputTokens, onChunk, signal }) {
  const url = `${GEMINI_BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
  const { controller, timer } = withTimeout(signal);
  let full = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        generationConfig: { maxOutputTokens: Number(maxOutputTokens) || 8192 }
      })
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) {}
      throw new Error(String(errorFromResponse(data, res.status)).slice(0, 300));
    }
    await streamSSE(res, (payload) => {
      let data = null;
      try { data = JSON.parse(payload); } catch (_) { return; }
      const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      if (parts) {
        for (const p of parts) {
          if (p && p.text) {
            full += p.text;
            onChunk(p.text);
          }
        }
      }
    });
    return full.trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) throw new Error('CANCELLED'); // user pressed Stop
      throw new Error('Request timed out (90s).');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function openAICompat({ apiKey, model, endpoint, systemPrompt, messages, maxOutputTokens, onChunk, signal }) {
  const { controller, timer } = withTimeout(signal);
  let full = '';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: Number(maxOutputTokens) || 8192,
        ...(onChunk ? { stream: true } : {})
      })
    });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch (_) {}
      throw new Error(String(errorFromResponse(data, res.status)).slice(0, 300));
    }
    if (!onChunk) {
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (typeof content !== 'string') throw new Error('No content in the model response.');
      return content.trim();
    }
    await streamSSE(res, (payload) => {
      if (payload === '[DONE]') return;
      let data = null;
      try { data = JSON.parse(payload); } catch (_) { return; }
      const delta = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        onChunk(delta);
      }
    });
    return full.trim();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (signal && signal.aborted) throw new Error('CANCELLED'); // user pressed Stop
      throw new Error('Request timed out (90s).');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Call the right provider. Returns the assistant's reply text. */
async function chat({ provider, apiKey, model, endpoint, systemPrompt, messages, maxOutputTokens, onChunk, signal }) {
  if (provider === 'gemini') {
    if (onChunk) return geminiStream({ apiKey, model, systemPrompt, messages, maxOutputTokens, onChunk, signal });
    return gemini({ apiKey, model, systemPrompt, messages, maxOutputTokens, signal });
  }
  // NVIDIA NIM is an OpenAI-compatible endpoint (Bearer key, /chat/completions).
  const openAiEndpoint =
    provider === 'groq'
      ? `${GROQ_BASE}/chat/completions`
      : provider === 'nvidia'
        ? `${NVIDIA_BASE}/chat/completions`
        : endpoint;
  return openAICompat({ apiKey, model, endpoint: openAiEndpoint, systemPrompt, messages, maxOutputTokens, onChunk, signal });
}

module.exports = { chat, streamSSE };
