'use strict';

/* ============================================================
   MineBot — AI Control page logic
   Admin-only. Chat with the selected AI; it can control the
   bot through tools ([tool:start], [tool:say:...], {wait:5s},
   (notes), plain text -> UI). Supports multiple saved chats
   (create / switch / delete), persisted in localStorage.
   ============================================================ */

const $ = (id) => document.getElementById(id);

const els = {
  select: $('ai-select'),
  statusBadge: $('ai-status'),
  chatTitle: $('chat-title'),
  convList: $('conv-list'),
  railBody: $('rail-body'),
  railCollapse: $('rail-collapse'),
  newChatBtn: $('new-chat'),
  deleteChatBtn: $('delete-chat'),
  chatTitleEdit: $('chat-title-edit'),
  chatMessages: $('chat-messages'),
  chatEmpty: $('chat-empty'),
  thinkingBar: $('thinking-bar'),
  thinkingStatus: $('thinking-status'),
  input: $('chat-input'),
  sendBtn: $('send-btn'),
  stopBtn: $('stop-btn'),
  clearBtn: $('clear-chat'),
  confirmModal: $('confirm-modal'),
  confirmTool: $('confirm-tool'),
  confirmDetail: $('confirm-detail'),
  confirmYes: $('confirm-yes'),
  confirmNo: $('confirm-no'),
  toasts: $('toasts'),
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  menuBtn: $('menu-btn'),
  connPillSidebar: $('conn-pill-sidebar'),
  connPillMobile: $('conn-pill-mobile'),
  userBadge: $('user-badge'),
  logoutBtn: $('logout-btn'),
  modeSwitch: $('mode-switch'),
  modeBtns: Array.from(document.querySelectorAll('.mode-btn')),
  modeHint: $('mode-hint')
};

// Legacy key — migrated into the conversations store on first load.
const HISTORY_KEY = 'minebot-ai-history';
const RAIL_KEY = 'mb-ai-rail';
const CONVS_KEY = 'minebot-ai-conversations';
const CURR_KEY = 'minebot-ai-chat-current';
const MODE_KEY = 'minebot-ai-mode';
const MAX_CONVS = 20;
const MAX_MSGS_PER_CONV = 60;

const MODE_HINTS = {
  agent: mbIco('robot') + ' Agent — every tool: start/stop, chat, inventory, drop, mine, attack, follow, guard, nearby scan.',
  build: mbIco('building-skyscraper') + ' Build Agent — construction specialist: list builds, check materials, build schematics in survival / creative / operator, stop or get items.'
};

const MODE_EMPTY = {
  agent: `${mbIco('message-circle')} Ask anything — e.g. <span class="text-violet-300 font-semibold">“what am I carrying?”</span> or <span class="text-violet-300 font-semibold">“start the bot and say hi in the chat”</span>.<br />
    <span class="text-xs text-slate-600">The AI can use tools: start / stop / reconnect / say / state / inventory / drop / mine / attack / follow / guard.</span>`,
  build: `${mbIco('building-skyscraper')} Build Agent — ask it to construct your saved schematics, e.g. <span class="text-violet-300 font-semibold">“what builds do I have?”</span> or <span class="text-violet-300 font-semibold">“build the house in creative mode”</span>.<br />
    <span class="text-xs text-slate-600">Tools: build list / info / materials / start (survival · creative · operator) / stop / status / get items.</span>`
};

let me = null;
let keys = [];
let activeKey = '';
let currentMode = 'agent';
let conversations = []; // [{ id, title, createdAt, updatedAt, history: [] }]
let currentId = null;
let history = []; // points at the current conversation's history
let gameSeen = new Set(); // dedupe in-game messages (live vs replay vs refresh)
let assistantSeen = new Set(); // dedupe replayed in-game AI replies
let socket = null;
let pendingConfirmId = null;
let streamBuffer = '';
let streamBubble = null; // { root, textEl } while the AI reply is typing
// true once the first ai:stream chunk arrives, until ai:response settles it.
// Used to tell "a fresh request is starting" apart from "a tool is executing
// mid-reply" (ai:thinking {on:true, status}) — the latter must NOT reset the
// live streaming bubble or it gets orphaned and duplicated.
let activeStream = false;

function currentConv() {
  return conversations.find((c) => c.id === currentId) || null;
}

/* ---------- Auth ---------- */

async function init() {
  const res = await fetch('/api/auth/me');
  const data = await res.json();
  if (!data.ok) {
    window.location.replace('/login.html');
    return;
  }
  me = data.user;
  if (me.role !== 'admin') {
    // The AI can drive the bot — admin only.
    window.location.replace('/');
    return;
  }
  els.userBadge.innerHTML = mbIco('user') + ` ${me.username} · Admin`;

  restoreMode();
  loadConversations();
  await loadKeys();
  await loadSettings();

  socket = io();
  wireSocket();

  els.sendBtn.addEventListener('click', send);
  els.stopBtn.addEventListener('click', () => {
    if (socket) socket.emit('ai:cancel');
    els.stopBtn.disabled = true; // one click is enough; re-enabled when it settles
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  els.clearBtn.addEventListener('click', clearChat);
  els.deleteChatBtn.addEventListener('click', () => deleteChat(currentId));
  els.newChatBtn.addEventListener('click', newChat);
  els.chatTitleEdit.addEventListener('click', (e) => { e.stopPropagation(); startRenameCurrent(); });
  els.convList.addEventListener('click', onConvListClick);
  els.railCollapse.addEventListener('click', () => {
    const collapsed = !els.railBody.classList.contains('hidden');
    els.railBody.classList.toggle('hidden', collapsed);
    els.railCollapse.title = collapsed ? 'Show chat list' : 'Collapse chat list';
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch (_) {}
  });
  try {
    if (localStorage.getItem(RAIL_KEY) === '1') els.railBody.classList.add('hidden');
  } catch (_) {}
  els.select.addEventListener('change', onSelectKey);
  els.modeBtns.forEach((btn) => {
    btn.addEventListener('click', () => applyMode(btn.dataset.mode === 'build' ? 'build' : 'agent'));
  });
  applyMode(currentMode);
  els.confirmYes.addEventListener('click', () => respondConfirm(true));
  els.confirmNo.addEventListener('click', () => respondConfirm(false));
  els.confirmModal.addEventListener('click', (e) => {
    if (e.target === els.confirmModal || e.target.id === 'confirm-backdrop') respondConfirm(false);
  });

  els.logoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/login.html');
  });

  els.menuBtn.addEventListener('click', () => {
    if (els.sidebar.classList.contains('translate-x-0')) closeSidebar();
    else openSidebar();
  });
  els.overlay.addEventListener('click', closeSidebar);
  document.querySelectorAll('[data-nav]').forEach((l) => l.addEventListener('click', closeSidebar));
}

/* ---------- Conversations ---------- */

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function deriveTitle(msgs) {
  const first = (Array.isArray(msgs) ? msgs : []).find((m) => m && m.role === 'user' && m.content);
  if (first) return String(first.content).replace(/\s+/g, ' ').trim().slice(0, 30);
  return 'New chat';
}

function newConversation() {
  const now = Date.now();
  return { id: genId(), title: 'New chat', createdAt: now, updatedAt: now, history: [] };
}

function loadConversations() {
  try {
    const raw = localStorage.getItem(CONVS_KEY);
    if (raw) {
      conversations = JSON.parse(raw) || [];
    } else {
      // Migrate the legacy single-history key into one conversation.
      const old = localStorage.getItem(HISTORY_KEY);
      const msgs = old ? JSON.parse(old) : [];
      conversations = Array.isArray(msgs) && msgs.length
        ? [{ ...newConversation(), title: deriveTitle(msgs), history: msgs }]
        : [];
      try { localStorage.removeItem(HISTORY_KEY); } catch (_) { /* ignore */ }
    }
    conversations = conversations.filter((c) => c && c.id && Array.isArray(c.history));
    if (!conversations.length) conversations.push(newConversation());
    currentId = localStorage.getItem(CURR_KEY);
    if (!conversations.some((c) => c.id === currentId)) {
      currentId = conversations[conversations.length - 1].id;
    }
  } catch (_) {
    conversations = [newConversation()];
    currentId = conversations[0].id;
  }
  history = currentConv().history;
  renderConvList();
  renderConversation();
}

function saveConversations() {
  const conv = currentConv();
  if (conv) {
    conv.updatedAt = Date.now();
    if (conv.title === 'New chat') conv.title = deriveTitle(conv.history);
    // Keep the in-memory copy bounded too, not just the stored one.
    conv.history = conv.history.slice(-MAX_MSGS_PER_CONV);
    history = conv.history;
  }
  try {
    const slim = conversations.slice(0, MAX_CONVS).map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      history: (c.history || []).slice(-MAX_MSGS_PER_CONV)
    }));
    localStorage.setItem(CONVS_KEY, JSON.stringify(slim));
    localStorage.setItem(CURR_KEY, currentId || '');
  } catch (_) {
    /* storage full or unavailable */
  }
  renderConvList();
}

function renderConvList() {
  els.convList.innerHTML = '';
  for (const c of conversations) {
    const active = c.id === currentId;
    const item = document.createElement('button');
    item.type = 'button';
    item.dataset.id = c.id;
    item.className =
      'conv-item group inline-flex items-center gap-1.5 max-w-full px-2.5 py-1.5 rounded-full text-xs font-semibold border transition-all ' +
      (active
        ? 'bg-emerald-500/10 border-emerald-400/40 text-emerald-200'
        : 'bg-white/[0.02] border-white/5 text-slate-400 hover:text-slate-200 hover:bg-white/[0.05] hover:border-white/10');
    // Inline styles guarantee a horizontal pill even if a CSS class is missing.
    item.style.cssText = 'display:inline-flex; align-items:center; gap:6px; max-width:100%';
    item.innerHTML = `
      <span class="conv-title truncate max-w-[8rem]">${escapeHtml(c.title)}</span>
      <span class="conv-rename hidden group-hover:inline-flex sm:inline-flex sm:opacity-0 group-hover:opacity-100 w-4 h-4 shrink-0 items-center justify-center rounded hover:text-emerald-300 text-slate-500 transition-all" data-rename="${escapeHtml(c.id)}" title="Rename chat">${mbIco('edit')}</span>
      <span class="conv-del hidden group-hover:inline-flex sm:inline-flex sm:opacity-0 group-hover:opacity-100 w-4 h-4 shrink-0 items-center justify-center rounded hover:text-red-300 text-slate-500 transition-all" data-del="${escapeHtml(c.id)}" title="Delete chat">${mbIco('trash')}</span>`;
    els.convList.appendChild(item);
  }
}

function onConvListClick(e) {
  const rename = e.target.closest('[data-rename]');
  if (rename) {
    e.stopPropagation();
    startRenameChat(rename.dataset.rename);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    deleteChat(del.dataset.del);
    return;
  }
  const item = e.target.closest('[data-id]');
  if (item) switchConversation(item.dataset.id);
}

/** Inline-rename a chat: swaps its title for an input; Enter/blur commits, Esc cancels. */
function startRenameChat(id) {
  // Renaming the currently-open chat mid-reply would wipe the in-flight
  // streamed bubble (renderConversation) — same rule as the pencil button.
  if (id === currentId && els.sendBtn.disabled) return toast('Wait for the AI to finish replying first.', 'info');
  const chip = els.convList.querySelector(`[data-id="${id}"]`);
  if (!chip) return;
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  const titleEl = chip.querySelector('.conv-title');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = conv.title;
  input.maxLength = 40;
  input.className = 'w-28 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-slate-100 outline-none';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { cancel(); }
  });
  input.addEventListener('blur', commit);
  let done = false;
  function commit() {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== conv.title) {
      conv.title = v.slice(0, 40);
      saveConversations();
      if (currentId === id) renderConversation(); // refresh the header title
    }
    renderConvList();
  }
  function cancel() {
    if (done) return;
    done = true;
    renderConvList();
  }
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

/** Rename the currently-open chat via the pencil next to the header title. */
function startRenameCurrent() {
  // Renaming mid-reply would wipe the in-flight streamed bubble (renderConversation).
  if (els.sendBtn.disabled) return toast('Wait for the AI to finish replying first.', 'info');
  const conv = currentConv();
  if (!conv) return;
  const titleEl = els.chatTitle;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = conv.title;
  input.maxLength = 40;
  input.className = 'input !w-44 !py-1 !text-sm font-bold';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { cancel(); }
  });
  input.addEventListener('blur', commit);
  let done = false;
  function commit() {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== conv.title) {
      conv.title = v.slice(0, 40);
      saveConversations();
    }
    renderConversation();
  }
  function cancel() {
    if (done) return;
    done = true;
    renderConversation();
  }
  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

function switchConversation(id) {
  if (id === currentId) return;
  if (els.sendBtn.disabled) return toast('Wait for the AI to finish replying first.', 'info');
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  currentId = id;
  history = conv.history;
  // Persist the selection so a refresh reopens the chat we switched to.
  saveConversations();
  renderConversation();
}

function newChat() {
  if (els.sendBtn.disabled) return toast('Wait for the AI to finish replying first.', 'info');
  conversations.unshift(newConversation());
  currentId = conversations[0].id;
  history = conversations[0].history;
  saveConversations();
  renderConversation();
}

function deleteChat(id) {
  if (els.sendBtn.disabled) return toast('Wait for the AI to finish replying first.', 'info');
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  if (!confirm(`Delete this chat${conv.title !== 'New chat' ? ` (“${conv.title}”)` : ''}? This cannot be undone.`)) return;
  conversations = conversations.filter((c) => c.id !== id);
  if (!conversations.length) conversations.push(newConversation());
  if (currentId === id) {
    currentId = conversations[0].id;
    history = conversations[0].history;
    saveConversations();
    renderConversation();
  } else {
    saveConversations();
    renderConvList();
  }
}

/** Wipe every message in the current conversation (keeps the chat itself). */
function clearChat() {
  if (els.sendBtn.disabled) return toast('Wait for the AI to finish replying first.', 'info');
  const conv = currentConv();
  if (!conv) return;
  conv.history = [];
  history = conv.history;
  saveConversations();
  renderConversation();
}

/** Re-render the current conversation from its persisted history. */
function renderConversation() {
  els.chatMessages.querySelectorAll('.animate-fade-up').forEach((n) => n.remove());
  gameSeen = new Set();
  assistantSeen = new Set();
  streamBuffer = '';
  streamBubble = null;
  activeStream = false;
  els.chatEmpty.classList.remove('hidden');
  els.chatEmpty.innerHTML = MODE_EMPTY[currentMode];

  const conv = currentConv();
  if (!conv) return;
  els.chatTitle.textContent = conv.title;
  els.chatTitle.title = conv.title;

  for (const m of conv.history) {
    if (m.role === 'user') {
      appendUser(m.content);
    } else if (m.role === 'error') {
      appendError(m.content);
    } else if (m.role === 'game') {
      // Mark as seen first so a server replay can never duplicate it.
      gameSeen.add(m.username + '\u0000' + m.content);
      appendGame(m.username, m.content, { replay: true });
    } else if (m.role === 'assistant') {
      assistantSeen.add(m.content || '');
      if (m.info && m.info.length) m.info.forEach((n) => appendInfo(n));
      if (m.content) appendAI(m.content);
      if (m.tools && m.tools.length) appendTools(m.tools);
    }
  }
  renderConvList();
  scrollToBottom();
}

/* ---------- AI keys & settings ---------- */

async function loadKeys() {
  const res = await fetch('/api/ai/keys');
  const data = await res.json();
  if (!data.ok) return;
  keys = data.keys || [];
  els.select.innerHTML =
    '<option value="">— Select an AI —</option>' +
    keys.map((k) => `<option value="${escapeHtml(k.name)}">${escapeHtml(k.name)} · ${k.provider}</option>`).join('');
}

async function loadSettings() {
  const res = await fetch('/api/ai/settings');
  const data = await res.json();
  if (!data.ok) return;
  const saved = (data.settings && data.settings.activeKey) || '';
  if (keys.some((k) => k.name === saved)) {
    activeKey = saved;
    els.select.value = saved;
  }
  updateStatus();
}

function onSelectKey() {
  activeKey = els.select.value;
  fetch('/api/ai/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activeKey })
  }).catch(() => {});
  updateStatus();
}

function updateStatus() {
  const k = keys.find((x) => x.name === activeKey);
  els.statusBadge.textContent = k ? `${k.provider} · ${k.model}` : 'no AI selected';
  els.statusBadge.className = 'badge ' + (k ? 'badge-emerald' : 'badge-slate');
}

/* ---------- Socket ---------- */

function wireSocket() {
  socket.on('connect', () => setConn(true));
  socket.on('disconnect', () => {
    setConn(false);
    setComposerBusy(false); // don't leave the composer stuck after a blip
    // A dropped socket also ends any in-flight reply: reset the stream state
    // so the next fresh request starts clean (otherwise stale partial text
    // from a lost stream would leak into the new reply bubble).
    activeStream = false;
    streamBuffer = '';
    removeStreamBubble();
    els.thinkingBar.classList.add('hidden');
  });

  socket.on('ai:thinking', ({ on, status }) => {
    els.thinkingBar.classList.toggle('hidden', !on);
    if (on) {
      setComposerBusy(true);
      if (els.thinkingStatus) els.thinkingStatus.textContent = status || 'AI is thinking…';
      // Only reset stream state when a FRESH request starts (nothing is
      // streaming yet). Tool-execution statuses arrive while the reply is
      // still streaming/settling — resetting there orphans the live bubble.
      if (!activeStream) {
        streamBuffer = '';
        streamBubble = null;
      }
      scrollToBottom();
    }
  });

  socket.on('ai:stream', ({ text }) => {
    activeStream = true;
    streamBuffer += text || '';
    if (!streamBubble) streamBubble = startStreamBubble();
    streamBubble.textEl.textContent = visibleText(streamBuffer);
    scrollToBottom();
  });

  socket.on('ai:response', (r) => {
    activeStream = false;
    setComposerBusy(false);
    // The engine rejects any pending tool confirm when the exchange ends
    // (including a Stop) — close the modal so it can never hang.
    els.confirmModal.classList.add('hidden');
    els.confirmModal.classList.remove('flex');
    renderResponse(r);
  });

  socket.on('ai:game-message', ({ username, message }) => {
    appendGame(username, message);
  });

  // Catch-up: in-game chat / AI replies that happened while this page was
  // closed or on another tab (the server keeps a short activity log).
  socket.on('ai:activity-history', (entries) => {
    for (const e of entries || []) {
      if (e.role === 'game') appendGame(e.username, e.message);
      else if (e.role === 'assistant' && e.message) appendAssistantReplay(e.message);
    }
    scrollToBottom();
  });

  socket.on('ai:confirm', (d) => {
    pendingConfirmId = d.id;
    els.confirmTool.textContent = describeConfirm(d);
    els.confirmDetail.textContent = d.detail || '';
    els.confirmModal.classList.remove('hidden');
    els.confirmModal.classList.add('flex');
  });
}

function respondConfirm(approved) {
  if (pendingConfirmId && socket) {
    socket.emit('ai:confirm-response', { id: pendingConfirmId, approved });
  }
  pendingConfirmId = null;
  els.confirmModal.classList.add('hidden');
  els.confirmModal.classList.remove('flex');
}

function describeConfirm(d) {
  if (d.detail) return d.detail;
  return `[tool:${d.tool}]` + (d.args && d.args.text ? ` — "${d.args.text}"` : '');
}

/* ---------- Chat ---------- */

function send() {
  if (els.sendBtn.disabled) return; // already thinking
  const text = els.input.value.trim();
  if (!text) return;
  if (!activeKey) return toast('Pick an AI from the dropdown first.', 'error');

  els.input.value = '';
  history.push({ role: 'user', content: text });
  appendUser(text);
  saveConversations();

  // The engine only reads { role, content } — don't ship the bulky tools/
  // info arrays (or empty entries) over the socket on every send.
  const slimHistory = history
    .slice(-14)
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' }))
    .filter((m) => m.content);
  socket.emit('ai:send', { keyName: activeKey, message: text, history: slimHistory, mode: currentMode }, (ack) => {
    if (ack && !ack.ok) toast(ack.error || 'Could not send the message.', 'error');
  });
}

/* ---------- Agent mode (Agent / Build Agent) ---------- */

function applyMode(mode) {
  currentMode = mode === 'build' ? 'build' : 'agent';
  try {
    localStorage.setItem(MODE_KEY, currentMode);
  } catch (_) {}
  els.modeBtns.forEach((btn) => {
    const on = btn.dataset.mode === currentMode;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  els.modeHint.innerHTML = MODE_HINTS[currentMode];
  if (els.chatEmpty) els.chatEmpty.innerHTML = MODE_EMPTY[currentMode];
}

function renderResponse(r) {
  if (!r.ok) {
    removeStreamBubble();
    appendError(r.error || 'Something went wrong.');
    history.push({ role: 'error', content: r.error || 'Something went wrong.' });
    saveConversations();
    scrollToBottom();
    return;
  }

  const info = r.info || [];
  const text = (r.text || '').trim();
  const tools = r.toolsUsed || [];

  if (streamBubble) {
    // The reply already streamed live — settle it in place: notes above,
    // the text (already visible) + tools chips below.
    for (const note of info) {
      els.chatMessages.insertBefore(buildInfoNode(note), streamBubble.root);
    }
    finalizeStreamBubble(text, tools);
  } else {
    for (const note of info) appendInfo(note);
    if (text) appendAI(text);
    if (tools.length) appendTools(tools);
  }

  // Persist the FULL reply — text, info notes AND the tools-used chips — so
  // switching tabs or refreshing never loses them. Tool OUTPUTS (console
  // logs etc.) can be huge, so they're kept for the live view only and
  // stripped before persisting to keep localStorage small.
  history.push({
    role: 'assistant',
    content: text || '',
    info,
    tools: tools.map((t) => ({ ...t, output: undefined }))
  });
  saveConversations();
  scrollToBottom();
}

/* ---------- Rendering ---------- */

function bubble(html) {
  els.chatEmpty.classList.add('hidden');
  const div = document.createElement('div');
  div.className = 'animate-fade-up flex';
  div.innerHTML = html;
  els.chatMessages.appendChild(div);
  return div;
}

function appendUser(text) {
  bubble(`
    <div class="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-emerald-500 to-teal-600 text-[#052e22] font-semibold text-sm px-4 py-3 shadow-lg shadow-emerald-500/20 whitespace-pre-wrap break-words">${escapeHtml(text)}</div>
  `);
  scrollToBottom();
}

function appendAI(text) {
  bubble(`
    <div class="mr-auto max-w-[80%]">
      <div class="rounded-2xl rounded-bl-md bg-slate-800/80 border border-white/5 text-slate-100 text-sm px-4 py-3 whitespace-pre-wrap break-words leading-relaxed">${escapeHtml(text)}</div>
    </div>
  `);
  scrollToBottom();
}

function buildInfoNode(note) {
  const el = document.createElement('div');
  el.className = 'animate-fade-up flex';
  el.innerHTML = `
    <div class="mx-auto max-w-[90%] rounded-xl bg-violet-500/10 border border-violet-400/20 text-violet-200 text-xs font-semibold px-4 py-2 text-center break-words">${mbIco('message-circle')} ${escapeHtml(note)}</div>
  `;
  return el;
}

function appendInfo(note) {
  els.chatEmpty.classList.add('hidden');
  els.chatMessages.appendChild(buildInfoNode(note));
}

function appendGame(username, message, opts = {}) {
  // Dedupe live arrivals against already-seen messages (replays, refresh
  // restores, duplicate socket delivery). opts.replay = rendering a message
  // that was already persisted (history restore) — always render, never push.
  const key = username + '\u0000' + message;
  if (!opts.replay) {
    if (gameSeen.has(key)) return;
    gameSeen.add(key);
    history.push({ role: 'game', username, content: message });
    saveConversations();
  }
  bubble(`
    <div class="mr-auto max-w-[80%]">
      <p class="text-[10px] uppercase tracking-wider text-emerald-500 font-bold mb-1">${mbIco('device-gamepad')} in-game · ${escapeHtml(username)}</p>
      <div class="rounded-2xl rounded-bl-md bg-emerald-500/10 border border-emerald-400/20 text-emerald-100 text-sm px-4 py-3 whitespace-pre-wrap break-words">${escapeHtml(message)}</div>
    </div>
  `);
  scrollToBottom();
}

/** Persist + render an in-game AI reply caught up from the server replay. */
function appendAssistantReplay(text) {
  if (assistantSeen.has(text)) return;
  assistantSeen.add(text);
  history.push({ role: 'assistant', content: text });
  saveConversations();
  appendAI(text);
}

function appendError(message) {
  bubble(`
    <div class="mx-auto max-w-[90%] rounded-xl bg-red-500/10 border border-red-400/25 text-red-200 text-xs font-semibold px-4 py-2.5 text-center break-words">${mbIco('alert-triangle')} ${escapeHtml(message)}</div>
  `);
}

function toolsChipsHtml(tools) {
  return tools
    .map((t) => {
      const icon = t.status === 'denied' ? mbIco('ban') : t.status === 'failed' ? mbIco('circle-x') : mbIco('check');
      const color = t.status === 'denied' ? 'text-amber-300 border-amber-400/30 bg-amber-500/10'
        : t.status === 'failed' ? 'text-red-300 border-red-400/30 bg-red-500/10'
        : 'text-emerald-300 border-emerald-400/30 bg-emerald-500/10';
      const label = t.tool === 'wait' ? `${t.tool} ${(t.args && t.args.wait) || ''}` : t.tool;
      const extra = t.detail && t.tool !== 'wait' ? ` — ${t.detail}` : '';
      return `<span class="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border ${color}">${icon} ${escapeHtml(label)}${escapeHtml(extra)}</span>`;
    })
    .join(' ');
}

function toolsBlockHtml(tools) {
  // Only show output blocks for tools the AI explicitly asked output for.
  const withOutput = tools.filter((t) => t.wantOutput && t.output);
  const outputHtml = withOutput.length
    ? `<div class="mt-2 space-y-1.5">
        <p class="text-[10px] uppercase tracking-wider text-violet-400 font-bold mb-1">${mbIco('send')} Tool output</p>
        ${withOutput
          .map(
            (t) => `
          <details class="rounded-lg bg-white/[0.03] border border-white/5 overflow-hidden">
            <summary class="cursor-pointer text-[11px] font-bold text-violet-300 px-3 py-1.5 select-none">${escapeHtml(t.tool)}${t.status === 'failed' ? ' · failed' : ''}</summary>
            <pre class="text-[11px] text-slate-400 px-3 py-2 whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">${escapeHtml(t.output)}</pre>
          </details>`
          )
          .join('')}
      </div>`
    : '';
  return `
    <div class="mx-auto max-w-full">
      <p class="text-[10px] uppercase tracking-wider text-slate-500 font-bold mb-1.5">${mbIco('tools')} Tools used</p>
      <div class="flex flex-wrap gap-2">${toolsChipsHtml(tools)}</div>
      ${outputHtml}
    </div>`;
}

function appendTools(tools) {
  bubble(toolsBlockHtml(tools));
}

/* ---------- Streaming ---------- */

function startStreamBubble() {
  els.chatEmpty.classList.add('hidden');
  const root = document.createElement('div');
  root.className = 'animate-fade-up flex';
  root.innerHTML = `
    <div class="mr-auto max-w-[80%]">
      <div class="stream-body rounded-2xl rounded-bl-md bg-slate-800/80 border border-white/5 text-slate-100 text-sm px-4 py-3 whitespace-pre-wrap break-words leading-relaxed">
        <span class="stream-text"></span><span class="stream-caret">▍</span>
      </div>
    </div>`;
  els.chatMessages.appendChild(root);
  return { root, textEl: root.querySelector('.stream-text') };
}

/** Hide the tool/wait/note syntax while the raw reply is typing. */
function visibleText(raw) {
  return String(raw || '')
    .replace(/\[tool:[^\]]*\]/g, '')
    .replace(/\{wait:[^}]*\}/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function finalizeStreamBubble(text, tools) {
  if (!streamBubble) return;
  const root = streamBubble.root;
  streamBubble = null;
  if (!text && !tools.length) {
    root.remove();
    return;
  }
  let html = '';
  if (text) {
    html += `<div class="mr-auto max-w-[80%]"><div class="rounded-2xl rounded-bl-md bg-slate-800/80 border border-white/5 text-slate-100 text-sm px-4 py-3 whitespace-pre-wrap break-words leading-relaxed">${escapeHtml(text)}</div></div>`;
  }
  if (tools.length) html += toolsBlockHtml(tools);
  root.innerHTML = html;
  root.classList.remove('animate-fade-up'); // no re-animation on settle
}

function removeStreamBubble() {
  if (streamBubble) {
    streamBubble.root.remove();
    streamBubble = null;
  }
}

/* ---------- Mode restore ---------- */

function restoreMode() {
  try {
    const saved = localStorage.getItem(MODE_KEY);
    currentMode = saved === 'build' ? 'build' : 'agent';
  } catch (_) {
    currentMode = 'agent';
  }
}

/* ---------- Helpers ---------- */

function scrollToBottom() {
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function setComposerBusy(busy) {
  els.sendBtn.disabled = busy;
  els.sendBtn.classList.toggle('hidden', busy);
  els.input.disabled = busy;
  els.input.classList.toggle('opacity-60', busy);
  // Swap Send for Stop while a generation is running.
  els.stopBtn.disabled = false;
  els.stopBtn.classList.toggle('hidden', !busy);
}

function setConn(online) {
  const cls = online ? 'text-emerald-400' : 'text-slate-500';
  els.connPillSidebar.textContent = online ? '● Online' : '○ Offline';
  els.connPillSidebar.className = 'text-xs font-bold ' + cls;
  els.connPillMobile.textContent = online ? '●' : '○';
  els.connPillMobile.className = 'text-xs font-bold ' + cls;
}

function openSidebar() {
  els.sidebar.classList.remove('-translate-x-full');
  els.sidebar.classList.add('translate-x-0');
  els.overlay.classList.remove('hidden');
}

function closeSidebar() {
  els.sidebar.classList.add('-translate-x-full');
  els.sidebar.classList.remove('translate-x-0');
  els.overlay.classList.add('hidden');
}

function toast(message, type = 'info') {
  const icon = type === 'success' ? mbIco('circle-check') : type === 'error' ? mbIco('circle-x') : mbIco('info-circle');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="select-none">${icon}</span><span>${escapeHtml(message)}</span>`;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 320);
  }, 3200);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ---------- Boot ---------- */

init();
