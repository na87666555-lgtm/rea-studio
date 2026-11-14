import { loadSettings, saveSettings, loadChats, saveChats, clearAll, uid } from './store.js';
import { PRESETS, FORMATS, ApiError, streamChat, streamTurn, toolResultMessages, listModels, friendlyError, presetForKey, keyMismatch } from './providers.js';
import { enabledTools, runTool, toolSystemPrompt, toolLabel, toolSettings } from './tools.js';
import { addAttachment, getFile, deleteFiles, clearFiles, blobToBase64, formatSize, KIND_ICON, PY_UPLOAD_DIR } from './files.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { acquire, release } from './queue.js';
import { TEAM_ROLES, suggestTeam, resolveTeam, runTeam } from './team.js';

// Bump together with version.json on every release.
const APP_VERSION = '2026.11.14-5';

const $ = (sel, root = document) => root.querySelector(sel);
const NEW_TITLE = 'नई चैट';
const MAX_BATCH = 50;
const MAX_TOOL_ROUNDS = 8;

let settings = loadSettings();
let chats = loadChats();
let currentId = chats[0]?.id || null;
let view = 'chat';
const running = new Map(); // chatId -> { controller, phase: 'queued' | 'streaming' }
let batch = null; // { chatIds: [] }
const multiDraft = { tasks: '', prefix: '', targets: [] };
let editingConnId = null;
let teamDraft = null;
let editingTeamId = null;
let pendingFiles = []; // attachments picked for the next message
let deferredInstall = null;
let installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const coarsePointer = matchMedia('(pointer: coarse)').matches;

// ---------- helpers ----------

function conn(id) { return settings.connections.find(c => c.id === id) || null; }
function defaultConn() { return conn(settings.defaultConnectionId) || settings.connections[0] || null; }
function chatById(id) { return chats.find(c => c.id === id) || null; }
function current() { return chatById(currentId); }
function lastMsg(chat) { return chat?.messages[chat.messages.length - 1] || null; }

function makeTitle(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? t.slice(0, 48) + '…' : t || NEW_TITLE;
}

let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

let saveTimer = null;
function persistChats(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    const keep = chats.filter(c => c.messages.length || c.id === currentId);
    if (!saveChats(keep)) toast('फ़ोन की स्टोरेज भर गई है। कुछ पुरानी चैट हटाएँ।');
  };
  if (now) doSave();
  else saveTimer = setTimeout(doSave, 800);
}

function persistSettings() {
  if (!saveSettings(settings)) toast('सेटिंग्स सेव नहीं हो पाईं।');
}

function touch(chat) {
  chat.updatedAt = Date.now();
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  persistChats();
}

function createChat({ connectionId, model, title } = {}) {
  const d = defaultConn();
  const chat = {
    id: uid(),
    title: title || NEW_TITLE,
    connectionId: connectionId ?? d?.id ?? null,
    model: model ?? d?.defaultModel ?? '',
    system: '',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  chats.unshift(chat);
  return chat;
}

// ---------- layout / navigation ----------

function openDrawer() {
  $('#drawer').classList.add('open');
  $('#scrim').hidden = false;
}
function closeDrawer() {
  $('#drawer').classList.remove('open');
  $('#scrim').hidden = true;
}

function show(v) {
  view = v;
  $('#chatView').hidden = v !== 'chat';
  $('#settingsView').hidden = v !== 'settings';
  $('#multiView').hidden = v !== 'multi';
  closeDrawer();
  if (v === 'settings') renderSettings();
  if (v === 'multi') renderMulti();
  if (v === 'chat') renderChat();
  renderTopbar();
  renderChatList();
}

function renderTopbar() {
  const chip = $('#modelChip');
  const back = $('#backBtn');
  if (view !== 'chat') {
    $('#topTitle').textContent = view === 'settings' ? 'API और सेटिंग्स' : 'एक साथ कई काम';
    chip.hidden = true;
    back.hidden = false;
    return;
  }
  back.hidden = true;
  chip.hidden = false;
  const chat = current();
  $('#topTitle').textContent = chat && chat.title !== NEW_TITLE ? chat.title : 'Rea Studio';
  if (chat?.team) {
    chip.textContent = '✦ तीन AI · साथ';
    chip.title = 'ChatGPT + Gemini + Claude · टीम सेटिंग्स';
    return;
  }
  const c = chat ? conn(chat.connectionId) : defaultConn();
  const model = chat ? chat.model : c?.defaultModel;
  chip.textContent = model || 'मॉडल चुनें';
  chip.title = c ? `${c.name} · ${model || ''}` : 'मॉडल चुनें';
}

function renderChatList() {
  const ul = $('#chatList');
  if (!chats.length) {
    ul.innerHTML = '<li class="empty-note">अभी कोई चैट नहीं</li>';
    return;
  }
  ul.innerHTML = chats.map(c => {
    const r = running.get(c.id);
    const m = lastMsg(c);
    let dot = '';
    if (r) dot = `<span class="dot ${r.phase === 'queued' ? 'queued' : 'live'}"></span>`;
    else if (m?.error) dot = '<span class="dot err"></span>';
    const active = c.id === currentId && view === 'chat' ? ' active' : '';
    const id = escapeHtml(c.id);
    return `<li class="chat-item${active}">
      <button type="button" class="chat-open" data-action="open-chat" data-id="${id}">${dot}<span class="chat-name">${c.team ? '✦ ' : ''}${escapeHtml(c.title)}</span></button>
      <button type="button" class="icon-btn small" data-action="delete-chat" data-id="${id}" aria-label="चैट हटाएँ">🗑</button>
    </li>`;
  }).join('');
}

// ---------- chat view ----------

function welcomeHtml() {
  const has = settings.connections.length > 0;
  if (current()?.team) return `<div class="welcome team-welcome">
    <div class="team-orbit" aria-hidden="true">✦</div><h1>तीन ताकतें। एक साझा जवाब।</h1>
    <p>ChatGPT · Gemini · Claude</p><p class="hint">अपना विषय लिखें या फ़ाइल जोड़ें। तीनों इसी प्रोजेक्ट की बातचीत देखकर साथ काम करेंगे।</p>
    <button type="button" class="btn" data-action="open-model">टीम और प्रोजेक्ट के निर्देश</button></div>`;
  return `<div class="welcome">
    <img src="icons/icon.svg" alt="" width="64" height="64">
    <h1>चलो काम शुरू करते हैं</h1>
    <button type="button" class="btn team-entry" data-action="new-team">✦ ChatGPT + Gemini + Claude</button>
    ${has ? '' : '<button type="button" class="btn primary" data-action="add-conn-direct">+ API जोड़ें</button>'}
    <button type="button" class="btn install-btn" data-action="install"${installed ? ' hidden' : ''}>📲 ऐप इंस्टॉल करें</button>
  </div>`;
}

function messageHtml(chat, m, i) {
  if (m.role === 'user') {
    const atts = (m.attachments || []).map(attachmentHtml).join('');
    const text = m.content ? `<div class="bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>` : '';
    return `<div class="msg user" data-i="${i}">${atts ? `<div class="msg-atts">${atts}</div>` : ''}${text}</div>`;
  }
  const r = running.get(chat.id);
  const isLast = i === chat.messages.length - 1;
  const parts = m.parts && m.parts.length ? m.parts : null;
  let body = parts
    ? parts.map((p, pi) => (p.type === 'text' ? renderMarkdown(p.text) : toolPartHtml(p, i, pi))).join('')
    : m.content ? renderMarkdown(m.content) : '';
  const lastPart = parts ? parts[parts.length - 1] : null;
  if (m.pending && r?.phase === 'queued' && !m.content) {
    body = '<div class="status-line">कतार में… (पहले से चल रहे काम खत्म होने का इंतज़ार)</div>';
  } else if (m.pending && (!m.content || (lastPart && lastPart.type === 'tool'))) {
    body += '<div class="typing" aria-label="लिख रहा है"><span></span><span></span><span></span></div>';
  }
  let extra = '';
  if (m.toolsUnsupported) extra += '<div class="status-line">इस मॉडल ने टूल्स (खोज/कोड) स्वीकार नहीं किए, इसलिए बिना टूल्स के जवाब दिया।</div>';
  if (m.toolLimit) extra += `<div class="status-line">टूल्स की सीमा (${MAX_TOOL_ROUNDS} बार) पूरी हो गई।</div>`;
  if (m.error) {
    extra += `<div class="err-box"><strong>${escapeHtml(m.error.title)}</strong>` +
      (m.error.detail ? `<div class="err-detail">${escapeHtml(m.error.detail)}</div>` : '') +
      (m.error.hint ? `<div class="err-hint">💡 ${escapeHtml(m.error.hint)}</div>` : '') + '</div>';
  }
  if (m.stopped) extra += '<div class="status-line">⏹ रोका गया</div>';
  if (m.stopReason === 'max_tokens' || m.stopReason === 'length') extra += '<div class="status-line">जवाब लंबाई की सीमा पर कट गया।</div>';
  if (m.stopReason === 'refusal') extra += '<div class="status-line">मॉडल ने इस अनुरोध का जवाब नहीं दिया।</div>';
  let actions = '';
  if (!m.pending) {
    actions = '<div class="msg-actions">' +
      (m.content ? `<button type="button" data-action="copy-msg" data-i="${i}">कॉपी</button>` : '') +
      (isLast ? `<button type="button" data-action="retry" data-i="${i}">↻ फिर से</button>` : '') +
      '</div>';
  }
  return `<div class="msg assistant" data-i="${i}"><div class="meta">${escapeHtml(m.teamRuns ? '✦ साझा जवाब' : m.model || chat.model || '')}</div>` +
    `${m.teamRuns ? teamProgressHtml(m, i) : ''}<div class="content md">${body}</div>${extra}${actions}</div>`;
}

function teamProgressHtml(m, i) {
  const labels = { queued: 'कतार में', working: 'काम कर रहा है', done: 'योगदान तैयार', error: 'त्रुटि', stopped: 'रुका' };
  const phase = { drafts: 'तीनों आपके विषय पर काम कर रहे हैं', synthesis: 'योगदान मिलाकर साझा जवाब बन रहा है', done: 'साझा जवाब तैयार', stopped: 'काम रुक गया', error: 'साझा जवाब पूरा नहीं हुआ' };
  const completed = m.teamRuns.filter(r => r?.status === 'done').length;
  return `<div class="team-progress"><div class="team-status">${phase[m.teamPhase] || 'टीम तैयारी कर रही है'} · ${completed}/3 योगदान</div>
    <div class="team-badges">${m.teamRuns.map(r => `<span class="team-badge ${escapeHtml(r.status)}"><strong>${escapeHtml(r.label)}</strong><span>${labels[r.status] || 'तैयारी'}</span></span>`).join('')}</div>
    <details class="team-contributions" data-mi="${i}"${m.teamOpen ? ' open' : ''}><summary>तीनों का योगदान देखें</summary>
    ${m.teamRuns.map(r => `<article class="team-contribution"><h3>${escapeHtml(r.label)} <small>${escapeHtml(r.model)}</small></h3>
      ${r.error ? `<p class="err-box">${escapeHtml(r.error)}</p>` : ''}${r.notice ? `<p class="hint">${escapeHtml(r.notice)}</p>` : ''}
      <div class="md">${renderMarkdown(r.text || 'अभी योगदान नहीं आया।')}</div>
      ${(r.steps || []).map(s => `<details><summary>🛠 ${escapeHtml(s.name)} · ${escapeHtml(s.status)}</summary><pre class="team-tool-output">${escapeHtml(s.output)}</pre></details>`).join('')}</article>`).join('')}</details></div>`;
}

function attachmentHtml(a) {
  if (a.kind === 'image' && a.thumb && /^data:image\/jpeg;base64,/.test(a.thumb)) {
    return `<img class="att-img" src="${a.thumb}" alt="${escapeHtml(a.name)}">`;
  }
  return `<span class="att-file">${KIND_ICON[a.kind] || '📎'} ${escapeHtml(a.name)} <span class="muted">· ${formatSize(a.size)}</span></span>`;
}

function renderAttachRow() {
  const row = $('#attachRow');
  row.hidden = !pendingFiles.length;
  row.innerHTML = pendingFiles.map((a, i) => `<span class="att-chip">${a.loading ? '<span class="tool-spin"></span>' : a.kind === 'image' && a.thumb ? `<img src="${a.thumb}" alt="">` : `<span>${KIND_ICON[a.kind] || '📎'}</span>`}` +
    `<span class="att-name">${escapeHtml(a.name)}</span>` +
    (a.loading ? '' : `<button type="button" class="att-x" data-action="remove-file" data-i="${i}" aria-label="हटाएँ">✕</button>`) + '</span>').join('');
}

async function onFilesPicked(list) {
  for (const file of list) {
    const placeholder = { id: uid(), name: file.name, kind: 'other', loading: true };
    pendingFiles.push(placeholder);
    renderAttachRow();
    try {
      const att = await addAttachment(file, placeholder.id);
      pendingFiles[pendingFiles.indexOf(placeholder)] = att;
    } catch (e) {
      pendingFiles = pendingFiles.filter(x => x !== placeholder);
      toast(e?.message || 'फ़ाइल नहीं जुड़ पाई।');
    }
    renderAttachRow();
  }
}

// Turns chat messages into model history, loading uploaded files from the
// device: photos go to the model as images, PDFs as documents (Anthropic
// format), small text files inline; everything else is handed to Python.
async function buildHistory(messages, c, toolConfig = settings) {
  const anth = c.format === 'anthropic';
  const py = enabledTools(toolConfig).some(t => t.name === 'run_python');
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' || !m.attachments?.length) { out.push({ role: m.role, content: m.content }); continue; }
    const images = [];
    const docs = [];
    const notes = [];
    for (const a of m.attachments) {
      const blob = await getFile(a.id).catch(() => null);
      if (!blob) { notes.push(`[The file "${a.name}" is no longer stored on this device.]`); continue; }
      if (a.kind === 'image') images.push({ mediaType: a.type || 'image/jpeg', data: await blobToBase64(blob) });
      else if (a.kind === 'pdf' && anth && blob.size <= 20 * 1024 * 1024) docs.push({ mediaType: 'application/pdf', data: await blobToBase64(blob) });
      else if (a.kind === 'text' && blob.size <= 300 * 1024) notes.push(`[File: ${a.name}]\n\`\`\`\n${(await blob.text()).slice(0, 100000)}\n\`\`\``);
      else if (py) notes.push(`[Attached file: ${a.name} (${a.type || a.kind}, ${formatSize(a.size)}). Use run_python to work with it; it is at ${PY_UPLOAD_DIR}/${a.name}.]`);
      else notes.push(`[Attached file: ${a.name} (${a.type || a.kind}, ${formatSize(a.size)}). This model can't open it directly; the Python tool is off.]`);
    }
    out.push({ role: 'user', content: [m.content, ...notes].filter(Boolean).join('\n\n'), images, docs });
  }
  return out;
}

async function chatFiles(chat) {
  const list = [];
  for (const m of chat.messages) {
    for (const a of m.attachments || []) {
      const blob = await getFile(a.id).catch(() => null);
      if (blob) list.push({ id: a.id, name: a.name, blob });
    }
  }
  return list;
}

function chatFileIds(list) {
  return list.flatMap(c => c.messages.flatMap(m => (m.attachments || []).map(a => a.id)));
}

function toolPartHtml(p, mi, pi) {
  const { icon, label, detail } = toolLabel(p.name, p.args || {});
  const st = p.status === 'running'
    ? '<span class="tool-spin" aria-label="चल रहा है"></span>'
    : p.status === 'error' ? '<span class="tool-st err">✕</span>' : '<span class="tool-st ok">✓</span>';
  const code = p.args && p.args.code ? `<div class="tool-label">कोड</div><pre>${escapeHtml(p.args.code)}</pre>` : '';
  const out = p.output ? `<div class="tool-label">नतीजा</div><pre>${escapeHtml(p.output)}</pre>` : '';
  return `<details class="tool" data-mi="${mi}" data-pi="${pi}"${p.open ? ' open' : ''}><summary>` +
    `<span class="tool-ico">${icon}</span><span class="tool-name">${escapeHtml(label)}</span>` +
    (detail ? `<span class="tool-detail">${escapeHtml(detail)}</span>` : '') + st +
    `</summary><div class="tool-body">${code}${out}</div></details>`;
}

function nearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}
function scrollToBottom() {
  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  const chat = current();
  const box = $('#messages');
  if (!chat || !chat.messages.length) {
    box.innerHTML = welcomeHtml();
  } else {
    box.innerHTML = chat.messages.map((m, i) => messageHtml(chat, m, i)).join('');
    scrollToBottom();
  }
  updateComposer();
}

function updateLastMessage() {
  const chat = current();
  if (!chat || !chat.messages.length) return;
  const i = chat.messages.length - 1;
  const node = $(`#messages .msg[data-i="${i}"]`);
  if (!node) { renderChat(); return; }
  const stick = nearBottom();
  node.outerHTML = messageHtml(chat, chat.messages[i], i);
  if (stick) scrollToBottom();
}

function updateComposer() {
  const chat = current();
  const btn = $('#sendBtn');
  const busy = chat && running.has(chat.id);
  btn.textContent = busy ? '■' : '➤';
  btn.classList.toggle('stop', !!busy);
  btn.setAttribute('aria-label', busy ? 'रोकें' : 'भेजें');
}

function autosize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

// Throttle streaming repaints to one per animation frame.
const dirty = new Set();
let rafPending = false;
function markDirty(chatId) {
  dirty.add(chatId);
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(flushDirty);
  }
}
function flushDirty() {
  rafPending = false;
  if (view === 'chat' && dirty.has(currentId)) updateLastMessage();
  if (view === 'multi' && batch && batch.chatIds.some(id => dirty.has(id))) renderBatchProgress();
  dirty.clear();
}

function refreshStatus(chat) {
  renderChatList();
  if (view === 'chat' && chat.id === currentId) { updateLastMessage(); updateComposer(); }
  if (view === 'multi') renderBatchProgress();
}

// ---------- generation ----------

async function runGeneration(chat) {
  if (chat.team) return runTeamGeneration(chat);
  const c = conn(chat.connectionId);
  const msg = lastMsg(chat);
  const controller = new AbortController();
  const state = { controller, phase: 'queued' };
  running.set(chat.id, state);
  refreshStatus(chat);
  let acquired = false;
  try {
    if (!c) throw new Error('इस चैट का API कनेक्शन नहीं मिला। ऊपर मॉडल का नाम दबाकर दूसरा चुनें।');
    if (!chat.model) throw new Error('कोई मॉडल नहीं चुना गया। ऊपर मॉडल का नाम दबाकर चुनें।');
    await acquire(c.id, c.maxParallel, controller.signal);
    acquired = true;
    state.phase = 'streaming';
    refreshStatus(chat);
    const tools = enabledTools(settings);
    let useTools = tools.length > 0;
    const baseSystem = chat.system || settings.systemPrompt || '';
    const trail = [];
    const history = await buildHistory(chat.messages.slice(0, -1), c);
    msg.parts = [];
    const addText = t => {
      const last = msg.parts[msg.parts.length - 1];
      if (last && last.type === 'text') last.text += t;
      else {
        if (msg.content) msg.content += '\n\n';
        msg.parts.push({ type: 'text', text: t });
      }
      msg.content += t;
      markDirty(chat.id);
      persistChats();
    };
    let res = null;
    let rounds = 0;
    while (true) {
      const system = [baseSystem, useTools ? toolSystemPrompt(settings) : ''].filter(Boolean).join('\n\n');
      try {
        res = await streamTurn({
          conn: c,
          model: chat.model,
          system,
          history,
          trail,
          tools: useTools ? tools : null,
          signal: controller.signal,
          onText: addText,
        });
      } catch (e) {
        // Some providers or models reject the `tools` field: answer without tools.
        if (useTools && !trail.length && !msg.content && e instanceof ApiError && [400, 404, 422].includes(e.status)) {
          useTools = false;
          msg.toolsUnsupported = true;
          continue;
        }
        throw e;
      }
      if (!res.toolCalls.length) break;
      if (rounds >= MAX_TOOL_ROUNDS) { msg.toolLimit = true; break; }
      rounds++;
      trail.push(res.assistantMessage);
      const results = [];
      for (const call of res.toolCalls) {
        const step = { type: 'tool', name: call.name, args: call.args || {}, status: 'running' };
        msg.parts.push(step);
        markDirty(chat.id);
        const out = await runTool(call.name, call.args || {}, settings, controller.signal, { files: () => chatFiles(chat) });
        step.status = out.ok ? 'done' : 'error';
        step.output = out.text.length > 4000 ? out.text.slice(0, 4000) + '…' : out.text;
        results.push({ id: call.id, ok: out.ok, text: out.text });
        markDirty(chat.id);
        persistChats();
      }
      trail.push(...toolResultMessages(c.format, results));
    }
    msg.stopReason = res?.stopReason || null;
    if (!msg.content && msg.stopReason !== 'refusal' && !msg.toolLimit) msg.error = { title: 'मॉडल ने खाली जवाब दिया।', detail: '' };
  } catch (e) {
    if (e?.name === 'AbortError') msg.stopped = true;
    else {
      msg.error = friendlyError(e);
      const mm = c && keyMismatch(c);
      if (mm) {
        msg.error.hint = `यह key ${mm.name} की लगती है, लेकिन "${c.name}" किसी दूसरे provider का पता है। ☰ → ⚙ API और सेटिंग्स में इसे "बदलें" दबाकर सेव करें, ऐप सही सेटिंग अपने आप भर देगा।`;
      }
    }
  } finally {
    if (acquired) release(c.id, c.maxParallel);
    delete msg.pending;
    running.delete(chat.id);
    touch(chat);
    persistChats(true);
    refreshStatus(chat);
    if (pendingUpdate) setTimeout(() => applyUpdate(pendingUpdate), 1500);
  }
}

async function runTeamGeneration(chat) {
  const msg = lastMsg(chat);
  const controller = new AbortController();
  running.set(chat.id, { controller, phase: 'streaming' });
  refreshStatus(chat);
  // Freeze the inputs for this run while other chats/settings remain usable.
  const sharedSettings = structuredClone(settings);
  const sharedMessages = structuredClone(chat.messages.slice(0, -1));
  const sharedSystem = chat.system || sharedSettings.systemPrompt || '';
  try {
    const members = resolveTeam(chat.team, sharedSettings.connections);
    msg.teamRuns = [];
    const result = await runTeam({ members, coordinator: chat.team.coordinator,
      system: [sharedSystem, toolSystemPrompt(sharedSettings)].filter(Boolean).join('\n\n'),
      getHistory: c => buildHistory(sharedMessages, c, sharedSettings),
      tools: enabledTools(sharedSettings), signal: controller.signal,
      executeTool: (name, args, signal) => runTool(name, args, sharedSettings, signal, { files: () => chatFiles({ messages: sharedMessages }) }),
      onMember: (i, data) => { msg.teamRuns[i] = data; markDirty(chat.id); persistChats(); },
      onPhase: phase => { msg.teamPhase = phase; markDirty(chat.id); },
      onText: text => { msg.content += text; markDirty(chat.id); persistChats(); },
    });
    msg.teamSummary = result;
    msg.stopReason = result.stopReason;
  } catch (error) {
    msg.teamPhase = controller.signal.aborted ? 'stopped' : 'error';
    if (controller.signal.aborted) msg.stopped = true;
    else msg.error = friendlyError(error);
  } finally {
    delete msg.pending;
    running.delete(chat.id);
    touch(chat); persistChats(true); refreshStatus(chat);
    if (pendingUpdate) setTimeout(() => applyUpdate(pendingUpdate), 1500);
  }
}

function startAssistant(chat) {
  chat.messages.push({ role: 'assistant', content: '', pending: true, model: chat.model, ts: Date.now() });
  touch(chat);
  if (chat.id === currentId && view === 'chat') { renderChat(); renderTopbar(); }
  runGeneration(chat);
}

function onSubmit(e) {
  e.preventDefault();
  let chat = current();
  if (chat && running.has(chat.id)) {
    running.get(chat.id).controller.abort();
    return;
  }
  const input = $('#input');
  const text = input.value.trim();
  if (pendingFiles.some(a => a.loading)) { toast('फ़ाइल तैयार हो रही है, एक पल रुकें।'); return; }
  if (!text && !pendingFiles.length) return;
  if (!settings.connections.length) {
    toast('पहले एक API जोड़ें।');
    openConnDialog(null);
    return;
  }
  if (!chat) { chat = createChat(); currentId = chat.id; }
  if (chat.team) {
    try { resolveTeam(chat.team, settings.connections); }
    catch (error) { toast(error.message); openTeamDialog(chat); return; }
  } else if (!conn(chat.connectionId)) {
    const d = defaultConn();
    chat.connectionId = d.id;
    if (!chat.model) chat.model = d.defaultModel || '';
  }
  if (!chat.team && !chat.model) {
    toast('पहले मॉडल चुनें।');
    openModelDialog();
    return;
  }
  input.value = '';
  autosize();
  const attachments = pendingFiles;
  pendingFiles = [];
  renderAttachRow();
  chat.messages.push({ role: 'user', content: text, ts: Date.now(), ...(attachments.length ? { attachments } : {}) });
  if (chat.title === NEW_TITLE) chat.title = makeTitle(text || attachments.map(a => a.name).join(', '));
  startAssistant(chat);
  renderChatList();
}

function retry(i) {
  const chat = current();
  if (!chat || running.has(chat.id) || i !== chat.messages.length - 1) return;
  chat.messages.splice(i, 1);
  if (lastMsg(chat)?.role !== 'user') { renderChat(); return; }
  startAssistant(chat);
}

function deleteChat(id) {
  const chat = chatById(id);
  if (!chat) return;
  if (!confirm(`"${chat.title}" हटाएँ?`)) return;
  running.get(id)?.controller.abort();
  deleteFiles(chatFileIds([chat])).catch(() => {});
  chats = chats.filter(c => c.id !== id);
  if (batch) batch.chatIds = batch.chatIds.filter(x => x !== id);
  if (currentId === id) currentId = chats[0]?.id || null;
  persistChats(true);
  renderChatList();
  if (view === 'chat') { renderChat(); renderTopbar(); }
  if (view === 'multi') renderBatchProgress();
}

// ---------- model dialog ----------

function readTeamDraft() {
  if (!teamDraft) return;
  teamDraft.members = TEAM_ROLES.map((r, i) => ({ id: r.id, label: r.label,
    connectionId: $(`#tdConn${i}`).value, model: $(`#tdModel${i}`).value.trim() }));
}

function renderTeamMembers() {
  $('#teamMembers').innerHTML = teamDraft.members.map((m, i) => {
    const c = conn(m.connectionId);
    return `<fieldset class="team-member"><legend>${TEAM_ROLES[i].label}</legend>
      <label>API कनेक्शन<select id="tdConn${i}" data-team-conn="${i}" required>
        <option value="">कनेक्शन चुनें</option>${settings.connections.map(c => `<option value="${escapeHtml(c.id)}"${c.id === m.connectionId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select></label>
      <label>मॉडल<input id="tdModel${i}" list="tdModels${i}" value="${escapeHtml(m.model)}" required autocomplete="off" spellcheck="false" placeholder="${TEAM_ROLES[i].label} मॉडल का नाम"></label>
      <datalist id="tdModels${i}">${(c?.models || []).map(model => `<option value="${escapeHtml(model)}"></option>`).join('')}</datalist>
      <button type="button" class="btn small" data-action="team-fetch" data-i="${i}">↻ मॉडल लिस्ट लाओ</button></fieldset>`;
  }).join('');
}

function openTeamDialog(chat = null) {
  if (chat && running.has(chat.id)) { toast('टीम बदलने से पहले चल रहा जवाब रोकें।'); return; }
  editingTeamId = chat?.id || null;
  teamDraft = structuredClone(chat?.team || { members: suggestTeam(settings.connections), coordinator: 2 });
  $('#tdTitle').value = chat?.title || '';
  $('#tdSystem').value = chat?.system || '';
  $('#tdCoordinator').value = String(teamDraft.coordinator ?? 2);
  $('#tdStatus').textContent = settings.connections.length ? '' : 'शुरू करने के लिए नीचे API कनेक्शन जोड़ें।';
  renderTeamMembers();
  $('#teamDialog').showModal();
}

async function fetchTeamModels(i, button) {
  const c = conn($(`#tdConn${i}`).value);
  if (!c) { $('#tdStatus').textContent = 'पहले API कनेक्शन चुनें।'; return; }
  button.disabled = true;
  $('#tdStatus').textContent = 'मॉडल लिस्ट आ रही है…';
  try {
    const models = await listModels(c, AbortSignal.timeout(30000));
    c.models = models; persistSettings();
    // A fetch for an old selection must not overwrite a newly chosen API.
    if ($(`#tdConn${i}`).value !== c.id) return;
    $(`#tdModels${i}`).innerHTML = models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
    if (!$(`#tdModel${i}`).value) $(`#tdModel${i}`).value = models.find(m => TEAM_ROLES[i].match.test(m)) || '';
    $('#tdStatus').textContent = `${models.length} मॉडल मिले। मॉडल वाले खाने से चुनें।`;
  } catch (error) { $('#tdStatus').textContent = friendlyError(error).title; }
  finally { button.disabled = false; }
}

function saveTeamDialog(e) {
  e.preventDefault(); readTeamDraft();
  try { resolveTeam(teamDraft, settings.connections); }
  catch (error) { $('#tdStatus').textContent = error.message; return; }
  let chat = editingTeamId ? chatById(editingTeamId) : null;
  if (editingTeamId && !chat) { $('#tdStatus').textContent = 'यह चैट हट चुकी है। नई टीम बनाएँ।'; return; }
  if (!chat) chat = createChat();
  chat.team = { members: structuredClone(teamDraft.members), coordinator: Number($('#tdCoordinator').value) };
  chat.title = $('#tdTitle').value.trim() || 'साझा प्रोजेक्ट';
  chat.system = $('#tdSystem').value.trim();
  currentId = chat.id; touch(chat); persistChats(true);
  $('#teamDialog').close(); show('chat'); $('#input').focus();
}

function fillPills(container, models, onPick) {
  container.innerHTML = models.slice(0, 80).map(m => `<button type="button" class="pill" data-model="${escapeHtml(m)}">${escapeHtml(m)}</button>`).join('');
  container.onclick = e => {
    const b = e.target.closest('.pill');
    if (b) onPick(b.dataset.model);
  };
}

function fillDatalist(dl, models) {
  dl.innerHTML = models.map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
}

function syncModelDialogModels() {
  const c = conn($('#mdConn').value);
  const models = c?.models || [];
  fillDatalist($('#mdModelList'), models);
  fillPills($('#mdModels'), models, m => { $('#mdModel').value = m; });
}

function openModelDialog() {
  if (current()?.team) { openTeamDialog(current()); return; }
  if (!settings.connections.length) {
    toast('पहले एक API जोड़ें।');
    openConnDialog(null);
    return;
  }
  const chat = current();
  const c = (chat && conn(chat.connectionId)) || defaultConn();
  const sel = $('#mdConn');
  sel.innerHTML = settings.connections.map(x => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
  sel.value = c.id;
  $('#mdModel').value = (chat && chat.connectionId === c.id ? chat.model : '') || c.defaultModel || '';
  $('#mdSystem').value = chat?.system || '';
  $('#mdStatus').textContent = '';
  syncModelDialogModels();
  $('#modelDialog').showModal();
}

async function fetchModelsInto(c, statusEl) {
  statusEl.textContent = 'मॉडल लिस्ट ला रहे हैं…';
  try {
    const models = await listModels(c);
    statusEl.textContent = models.length ? `${models.length} मॉडल मिले। नीचे से चुनें।` : 'कोई मॉडल नहीं मिला। नाम खुद लिखें।';
    return models;
  } catch (e) {
    const f = friendlyError(e);
    statusEl.textContent = `लिस्ट नहीं आई: ${f.title} ${f.detail || ''}`.trim();
    return null;
  }
}

async function mdFetch() {
  const c = conn($('#mdConn').value);
  if (!c) return;
  const models = await fetchModelsInto(c, $('#mdStatus'));
  if (models && models.length) {
    c.models = models;
    persistSettings();
    syncModelDialogModels();
  }
}

function saveModelDialog(e) {
  e.preventDefault();
  const c = conn($('#mdConn').value);
  const model = $('#mdModel').value.trim();
  if (!c || !model) { toast('API और मॉडल दोनों चुनें।'); return; }
  let chat = current();
  if (!chat) { chat = createChat(); currentId = chat.id; }
  chat.connectionId = c.id;
  chat.model = model;
  chat.system = $('#mdSystem').value.trim();
  settings.defaultConnectionId = c.id;
  c.defaultModel = model;
  persistSettings();
  persistChats(true);
  $('#modelDialog').close();
  renderTopbar();
  renderChatList();
  if (view === 'chat') renderChat();
}

// ---------- connection dialog ----------

function connFormValues() {
  return {
    name: $('#cdName').value.trim(),
    format: $('#cdFormat').value,
    baseUrl: $('#cdBase').value.trim(),
    apiKey: $('#cdKey').value.trim(),
    defaultModel: $('#cdModel').value.trim(),
    maxParallel: Math.min(20, Math.max(1, parseInt($('#cdParallel').value, 10) || 3)),
    maxTokens: parseInt($('#cdMaxTokens').value, 10) || '',
    anthropicVersion: $('#cdVersion').value.trim() || '2023-06-01',
  };
}

let dialogModels = [];
function setDialogModels(models) {
  dialogModels = models || [];
  fillDatalist($('#cdModelList'), dialogModels);
  fillPills($('#cdModels'), dialogModels, m => { $('#cdModel').value = m; });
}

function syncFormatFields() {
  $('#cdVersionWrap').hidden = $('#cdFormat').value !== 'anthropic';
}

function applyPreset(p) {
  $('#cdName').value = p.id.startsWith('custom') ? '' : p.name;
  $('#cdFormat').value = p.format;
  $('#cdBase').value = p.baseUrl;
  $('#cdModel').value = p.defaultModel || '';
  $('#cdParallel').value = p.maxParallel || 3;
  $('#cdMaxTokens').value = p.maxTokens || '';
  $('#cdVersion').value = p.anthropicVersion || '2023-06-01';
  $('#cdHint').textContent = p.hint || '';
  setDialogModels(p.models || []);
  syncFormatFields();
}

function openConnDialog(id) {
  editingConnId = id;
  const c = id ? conn(id) : null;
  $('#cdTitle').textContent = c ? 'API बदलें' : 'नया API जोड़ें';
  $('#cdPresetWrap').hidden = !!c;
  $('#cdStatus').textContent = '';
  $('#cdKey').type = 'password';
  if (c) {
    $('#cdName').value = c.name;
    $('#cdFormat').value = c.format;
    $('#cdBase').value = c.baseUrl;
    $('#cdKey').value = c.apiKey || '';
    $('#cdModel').value = c.defaultModel || '';
    $('#cdParallel').value = c.maxParallel || 3;
    $('#cdMaxTokens').value = c.maxTokens || '';
    $('#cdVersion').value = c.anthropicVersion || '2023-06-01';
    $('#cdHint').textContent = '';
    setDialogModels(c.models || []);
    syncFormatFields();
  } else {
    const sel = $('#cdPreset');
    sel.innerHTML = PRESETS.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    sel.value = PRESETS[0].id;
    $('#cdKey').value = '';
    applyPreset(PRESETS[0]);
  }
  $('#connDialog').showModal();
}

// Pasting a key with a known prefix (e.g. coa_ for Coarena) picks that provider.
function onKeyInput() {
  const p = presetForKey($('#cdKey').value);
  if (!p) return;
  if (!editingConnId) {
    if ($('#cdPreset').value !== p.id) {
      $('#cdPreset').value = p.id;
      applyPreset(p);
      $('#cdStatus').textContent = `✓ key से पहचाना: ${p.name}। सेटिंग अपने आप भर दी गई।`;
    }
  } else if (keyMismatch({ apiKey: $('#cdKey').value, baseUrl: $('#cdBase').value })) {
    $('#cdStatus').textContent = `यह key ${p.name} की लगती है। सेव दबाने पर सही सेटिंग भरने का विकल्प मिलेगा।`;
  }
}

function draftConn() {
  const v = connFormValues();
  return { id: editingConnId || 'draft', ...v };
}

async function cdFetch() {
  const d = draftConn();
  if (!d.baseUrl) { $('#cdStatus').textContent = 'पहले Base URL डालें।'; return; }
  const models = await fetchModelsInto(d, $('#cdStatus'));
  if (models && models.length) setDialogModels(models);
}

async function cdTest() {
  const d = draftConn();
  const status = $('#cdStatus');
  if (!d.baseUrl || !d.defaultModel) { status.textContent = 'टेस्ट के लिए Base URL और मॉडल दोनों चाहिए।'; return; }
  const mm = keyMismatch(d);
  if (mm) { status.textContent = `✕ यह key ${mm.name} की लगती है। ऊपर Provider में "${mm.name}" चुनें।`; return; }
  status.textContent = 'टेस्ट हो रहा है…';
  let text = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    await streamChat({
      conn: { ...d, maxTokens: d.maxTokens || 200 },
      model: d.defaultModel,
      system: '',
      messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
      signal: controller.signal,
      onDelta: t => { text += t; },
    });
    clearTimeout(timer);
    status.textContent = `✓ काम कर रहा है। जवाब: "${text.trim().slice(0, 80)}"`;
  } catch (e) {
    if (e?.name === 'AbortError') { status.textContent = '✕ जवाब नहीं आया (समय खत्म)।'; return; }
    const f = friendlyError(e);
    status.textContent = `✕ ${f.title} ${f.detail || ''}`.trim();
  }
}

function saveConnDialog(e) {
  e.preventDefault();
  const v = connFormValues();
  if (!v.name) { toast('नाम डालें।'); return; }
  if (!/^https?:\/\//i.test(v.baseUrl)) { toast('Base URL http:// या https:// से शुरू होना चाहिए।'); return; }
  if (/^http:\/\//i.test(v.baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(v.baseUrl)) {
    toast('सुरक्षा के लिए https:// वाला पता डालें।');
    return;
  }
  const mm = keyMismatch(v);
  if (mm && confirm(`यह key ${mm.name} की लगती है, लेकिन Base URL किसी दूसरे provider का है।\n\n${mm.name} की सही सेटिंग अपने आप भर दूँ?`)) {
    const wasPresetName = !v.name || PRESETS.some(p => p.name === v.name);
    Object.assign(v, {
      format: mm.format,
      baseUrl: mm.baseUrl,
      defaultModel: mm.defaultModel || v.defaultModel,
      maxParallel: mm.maxParallel || v.maxParallel,
      maxTokens: mm.maxTokens || '',
      anthropicVersion: mm.anthropicVersion || v.anthropicVersion,
    });
    if (wasPresetName) v.name = mm.name;
    dialogModels = mm.models || [];
  }
  if (editingConnId) {
    const c = conn(editingConnId);
    Object.assign(c, v, { models: dialogModels.length ? dialogModels : c.models || [] });
  } else {
    const c = { id: uid(), ...v, models: dialogModels };
    settings.connections.push(c);
    if (!settings.defaultConnectionId) settings.defaultConnectionId = c.id;
    // Give an empty current chat this connection right away.
    const chat = current();
    if (chat && !chat.messages.length && !conn(chat.connectionId)) {
      chat.connectionId = c.id;
      chat.model = c.defaultModel || '';
    }
  }
  persistSettings();
  $('#connDialog').close();
  toast('सेव हो गया।');
  if (view === 'settings') renderSettings();
  if (view === 'multi') renderMulti();
  if (view === 'chat') renderChat();
  if ($('#teamDialog').open && teamDraft) {
    readTeamDraft();
    const suggestions = suggestTeam(settings.connections);
    teamDraft.members = teamDraft.members.map((m, i) => m.connectionId ? m : suggestions[i]);
    renderTeamMembers();
  }
  renderTopbar();
}

// ---------- settings view ----------

function connCard(c) {
  const id = escapeHtml(c.id);
  const isDefault = c.id === settings.defaultConnectionId;
  const key = !c.apiKey ? 'नहीं' : c.apiKey.length > 12 ? '••••' + escapeHtml(c.apiKey.slice(-4)) : '••••';
  return `<div class="conn-card">
    <div class="conn-name">${escapeHtml(c.name)} ${isDefault ? '<span class="tag">डिफ़ॉल्ट</span>' : ''}</div>
    <div class="muted small">${escapeHtml(FORMATS[c.format] || c.format)}</div>
    <div class="muted small break">${escapeHtml(c.baseUrl)}</div>
    <div class="muted small">मॉडल: ${escapeHtml(c.defaultModel || '—')} · key: ${key} · एक साथ: ${escapeHtml(c.maxParallel)}</div>
    <div class="row wrap">
      <button type="button" class="btn small" data-action="edit-conn" data-id="${id}">बदलें</button>
      ${isDefault ? '' : `<button type="button" class="btn small" data-action="default-conn" data-id="${id}">डिफ़ॉल्ट बनाएँ</button>`}
      <button type="button" class="btn small danger" data-action="delete-conn" data-id="${id}">हटाएँ</button>
    </div>
  </div>`;
}

function renderSettings() {
  const v = $('#settingsView');
  v.innerHTML = `<div class="panel-inner">
    <p class="note">🔒 आपकी API keys सिर्फ इसी फ़ोन के ब्राउज़र में सेव रहती हैं। ये किसी सर्वर पर नहीं जातीं, सिर्फ उसी provider को भेजी जाती हैं जिसका Base URL आपने डाला है।</p>
    <h2>API कनेक्शन</h2>
    <div class="conn-list">${settings.connections.length ? settings.connections.map(connCard).join('') : '<p class="muted">अभी कोई API नहीं जोड़ा गया।</p>'}</div>
    <button type="button" class="btn primary" data-action="add-conn">+ नया API जोड़ें</button>

    <h2>🛠 टूल्स (खोज और कोड)</h2>
    ${toolSettingsHtml()}

    <h2>सभी चैट के लिए डिफ़ॉल्ट निर्देश</h2>
    <textarea id="globalSystem" rows="3" placeholder="जैसे: हमेशा आसान हिंदी में जवाब दो।">${escapeHtml(settings.systemPrompt || '')}</textarea>

    <h2>फ़ोन पर ऐप की तरह इंस्टॉल करें</h2>
    ${installed
      ? '<p class="muted">✓ यह ऐप इंस्टॉल होकर चल रहा है।</p>'
      : '<button type="button" class="btn primary install-btn" data-action="install">📲 अभी इंस्टॉल करें</button>'}

    <h2>डेटा</h2>
    <div class="row wrap">
      <button type="button" class="btn" data-action="export">⬇ चैट का बैकअप</button>
      <button type="button" class="btn danger" data-action="clear-chats">सारी चैट हटाएँ</button>
      <button type="button" class="btn danger" data-action="clear-all">सब कुछ हटाएँ (keys भी)</button>
    </div>
    <p class="muted small">बैकअप फ़ाइल में API keys नहीं होतीं।</p>
  </div>`;
  v.querySelectorAll('[data-tool]').forEach(el => el.addEventListener('change', () => {
    settings.tools = { ...toolSettings(settings), [el.dataset.tool]: el.checked };
    persistSettings();
    renderSettings();
  }));
  v.querySelectorAll('[data-toolkey]').forEach(el => el.addEventListener('input', () => {
    settings.tools = { ...toolSettings(settings), [el.dataset.toolkey]: el.value.trim() };
    persistSettings();
  }));
  $('#globalSystem').addEventListener('input', e => {
    settings.systemPrompt = e.target.value;
    persistSettings();
  });
}

function toolSettingsHtml() {
  const t = toolSettings(settings);
  const box = (key, text) => `<label class="check"><input type="checkbox" data-tool="${key}"${t[key] ? ' checked' : ''}${key !== 'enabled' && !t.enabled ? ' disabled' : ''}> ${text}</label>`;
  return `<div class="tools-box">
    ${box('enabled', '<strong>टूल्स चालू</strong>')}
    <div class="tool-toggles">
      ${box('search', '🔎 वेब खोज')}
      ${box('read', '📄 वेब पेज पढ़ना')}
      ${box('js', '▶ JavaScript चलाना')}
      ${box('python', '🐍 Python चलाना')}
    </div>
    <label>Tavily key (पूरे इंटरनेट की खोज के लिए, वैकल्पिक)
      <input type="password" data-toolkey="tavilyKey" value="${escapeHtml(t.tavilyKey)}" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="tvly-…">
    </label>
    <label>Jina key (वैकल्पिक)
      <input type="password" data-toolkey="jinaKey" value="${escapeHtml(t.jinaKey)}" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="jina_…">
    </label>
    <p class="muted small">बिना key के खोज सिर्फ Wikipedia में होती है। tavily.com या jina.ai पर मुफ्त key मिलती है। कोड आपके फ़ोन में ही, एक अलग सुरक्षित हिस्से में चलता है।</p>
  </div>`;
}

function exportChats() {
  const data = JSON.stringify({ app: 'rea-studio', exportedAt: new Date().toISOString(), chats }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `rea-studio-chats-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function abortAll() {
  for (const r of running.values()) r.controller.abort();
}

// ---------- multi-task view ----------

function targetRow(t, i) {
  const opts = settings.connections.map(c =>
    `<option value="${escapeHtml(c.id)}"${c.id === t.connectionId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const c = conn(t.connectionId);
  const list = (c?.models || []).map(m => `<option value="${escapeHtml(m)}"></option>`).join('');
  return `<div class="target-row" data-i="${i}">
    <select data-field="connectionId" aria-label="API">${opts}</select>
    <input data-field="model" list="mtModels-${i}" value="${escapeHtml(t.model)}" placeholder="मॉडल" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="मॉडल">
    <datalist id="mtModels-${i}">${list}</datalist>
    ${multiDraft.targets.length > 1 ? `<button type="button" class="icon-btn small" data-action="mt-remove-target" data-i="${i}" aria-label="हटाएँ">✕</button>` : ''}
  </div>`;
}

function renderMulti() {
  const v = $('#multiView');
  if (!settings.connections.length) {
    v.innerHTML = `<div class="panel-inner"><p>इसके लिए पहले एक API जोड़ें।</p>
      <button type="button" class="btn primary" data-action="add-conn-direct">+ API जोड़ें</button></div>`;
    return;
  }
  multiDraft.targets = multiDraft.targets.filter(t => conn(t.connectionId));
  if (!multiDraft.targets.length) {
    const d = defaultConn();
    multiDraft.targets.push({ connectionId: d.id, model: d.defaultModel || '' });
  }
  v.innerHTML = `<div class="panel-inner">
    <p class="muted">हर लाइन में एक अलग काम लिखें। हर काम अपनी अलग चैट में <strong>एक साथ</strong> चलेगा। एक से ज़्यादा मॉडल जोड़ेंगे तो हर काम हर मॉडल पर चलेगा, जिससे जवाबों की तुलना हो सके।</p>
    <label>काम (हर लाइन = एक काम)
      <textarea id="mtTasks" rows="6" placeholder="दिल्ली के 5 घूमने की जगहें बताओ&#10;एक छोटी कहानी लिखो&#10;Python में फिबोनाची का कोड लिखो">${escapeHtml(multiDraft.tasks)}</textarea>
    </label>
    <label>सभी कामों के लिए साझा निर्देश (वैकल्पिक)
      <textarea id="mtPrefix" rows="2" placeholder="जैसे: हर जवाब हिंदी में और छोटा दो।">${escapeHtml(multiDraft.prefix)}</textarea>
    </label>
    <div class="label-like">किस मॉडल पर चलाना है</div>
    <div class="targets">${multiDraft.targets.map(targetRow).join('')}</div>
    <div class="row wrap">
      <button type="button" class="btn small" data-action="mt-add-target">+ एक और मॉडल (तुलना)</button>
    </div>
    <p class="muted small">हर API की "एक साथ कितनी requests" सेटिंग के हिसाब से काम चलते हैं, बाकी कतार में इंतज़ार करते हैं।</p>
    <button type="button" class="btn primary block" data-action="mt-run">▶ सब एक साथ शुरू करें</button>
    <div id="batchProgress" class="batch"></div>
  </div>`;
  $('#mtTasks').addEventListener('input', e => { multiDraft.tasks = e.target.value; });
  $('#mtPrefix').addEventListener('input', e => { multiDraft.prefix = e.target.value; });
  v.querySelectorAll('.target-row').forEach(row => {
    const i = Number(row.dataset.i);
    row.querySelector('select').addEventListener('change', e => {
      const c = conn(e.target.value);
      multiDraft.targets[i] = { connectionId: c.id, model: c.defaultModel || '' };
      renderMulti();
    });
    row.querySelector('input').addEventListener('input', e => { multiDraft.targets[i].model = e.target.value; });
  });
  renderBatchProgress();
}

function runBatch() {
  const tasks = multiDraft.tasks.split('\n').map(s => s.trim()).filter(Boolean);
  if (!tasks.length) { toast('कम से कम एक काम लिखें।'); return; }
  const targets = multiDraft.targets
    .map(t => ({ connectionId: t.connectionId, model: (t.model || '').trim() }))
    .filter(t => conn(t.connectionId) && t.model);
  if (!targets.length) { toast('API और मॉडल चुनें।'); return; }
  if (tasks.length * targets.length > MAX_BATCH) { toast(`एक बार में ज़्यादा से ज़्यादा ${MAX_BATCH} काम।`); return; }
  const prefix = multiDraft.prefix.trim();
  batch = { chatIds: [] };
  for (const task of tasks) {
    for (const t of targets) {
      const chat = createChat({ connectionId: t.connectionId, model: t.model, title: makeTitle(task) });
      chat.messages.push({ role: 'user', content: prefix ? `${prefix}\n\n${task}` : task, ts: Date.now() });
      chat.messages.push({ role: 'assistant', content: '', pending: true, model: t.model, ts: Date.now() });
      batch.chatIds.push(chat.id);
    }
  }
  persistChats(true);
  for (const id of batch.chatIds) runGeneration(chatById(id));
  renderChatList();
  renderBatchProgress();
  toast(`${batch.chatIds.length} काम शुरू हो गए।`);
}

function renderBatchProgress() {
  const box = $('#batchProgress');
  if (!box || !batch) return;
  const items = batch.chatIds.map(chatById).filter(Boolean);
  let done = 0; let failed = 0; let live = 0; let queued = 0;
  const rows = items.map(c => {
    const m = lastMsg(c);
    const r = running.get(c.id);
    let st; let cls;
    if (r && r.phase === 'queued') { st = 'कतार में'; cls = 'queued'; queued++; }
    else if (r) { st = 'चल रहा है'; cls = 'live'; live++; }
    else if (m?.error || m?.stopped) { st = m.error ? 'त्रुटि' : 'रोका गया'; cls = 'err'; failed++; }
    else { st = 'पूरा'; cls = 'done'; done++; }
    const preview = (m?.content || m?.error?.title || '').replace(/\s+/g, ' ').slice(0, 160);
    return `<button type="button" class="batch-item" data-action="open-chat" data-id="${escapeHtml(c.id)}">
      <span class="dot ${cls}"></span>
      <span class="bi-main">
        <span class="bi-title">${escapeHtml(c.title)}</span>
        <span class="muted small">${escapeHtml(c.model)} · ${st}</span>
        ${preview ? `<span class="bi-preview">${escapeHtml(preview)}</span>` : ''}
      </span>
    </button>`;
  }).join('');
  const parts = [`${done}/${items.length} पूरे`];
  if (live) parts.push(`${live} चल रहे`);
  if (queued) parts.push(`${queued} कतार में`);
  if (failed) parts.push(`${failed} अधूरे`);
  box.innerHTML = `<h2>प्रगति: ${parts.join(' · ')}</h2>${rows}` +
    (live || queued ? '<button type="button" class="btn danger small" data-action="mt-stop">⏹ सब रोकें</button>' : '');
}

// ---------- auto update ----------
// The app checks version.json while it is open. When a newer version is
// published it reloads itself, but never while a reply is streaming or while
// there is unsent text in the message box.

let pendingUpdate = null;

function safeToReload() {
  return running.size === 0 && !pendingFiles.length && !$('#input').value.trim() && !document.querySelector('dialog[open]');
}

const APP_FILES = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/store.js', 'js/providers.js',
  'js/markdown.js', 'js/queue.js', 'js/team.js', 'js/tools.js', 'js/files.js', 'js/run-worker.js', 'js/py-worker.js', 'manifest.webmanifest', 'sw.js'];

let updating = false;
async function applyUpdate(version) {
  pendingUpdate = version;
  if (updating || !safeToReload()) return;
  try {
    if (sessionStorage.getItem('rea.reloadedFor') === version) return; // avoid reload loops
    sessionStorage.setItem('rea.reloadedFor', version);
    sessionStorage.setItem('rea.justUpdated', '1');
  } catch {
    return;
  }
  updating = true;
  persistChats(true);
  // Replace the browser's saved copies (GitHub Pages lets them live 10 min)
  // with fresh ones, so the reload really starts the new version.
  await Promise.all(APP_FILES.map(u => fetch(u, { cache: 'reload' }).catch(() => {})));
  location.reload();
}

async function checkForUpdate() {
  if (!navigator.onLine) return;
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = await res.json();
    if (version && version !== APP_VERSION) applyUpdate(version);
  } catch {
    // offline or blocked: try again later
  }
}

function startAutoUpdate() {
  try {
    if (sessionStorage.getItem('rea.justUpdated')) {
      sessionStorage.removeItem('rea.justUpdated');
      setTimeout(() => toast('✓ ऐप अपडेट हो गया'), 400);
    }
  } catch { /* ignore */ }
  setTimeout(checkForUpdate, 1500);
  setInterval(checkForUpdate, 3 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
  window.addEventListener('online', checkForUpdate);
}

// ---------- install ----------

function syncInstallButtons() {
  document.querySelectorAll('[data-action="install"]').forEach(b => { b.hidden = installed; });
}

function openInstallHelp() {
  const ua = navigator.userAgent;
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  $('#installIos').hidden = android && !ios;
  $('#installAndroid').hidden = ios;
  $('#installDialog').showModal();
}

async function installApp() {
  if (!deferredInstall) { openInstallHelp(); return; }
  const ev = deferredInstall;
  deferredInstall = null;
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    if (choice && choice.outcome === 'accepted') toast('ऐप इंस्टॉल हो रहा है…');
  } catch {
    openInstallHelp();
  }
}

// ---------- events ----------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('कॉपी हो गया');
  } catch {
    toast('कॉपी नहीं हो पाया');
  }
}

function onClick(e) {
  const codeBtn = e.target.closest('.copy-code');
  if (codeBtn) {
    copyText(codeBtn.closest('.code').querySelector('pre').textContent);
    return;
  }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.action) {
    case 'new-team': closeDrawer(); openTeamDialog(); break;
    case 'team-add-api': readTeamDraft(); openConnDialog(null); break;
    case 'team-fetch': fetchTeamModels(Number(b.dataset.i), b); break;
    case 'open-drawer': openDrawer(); break;
    case 'close-drawer': closeDrawer(); break;
    case 'new-chat': {
      const cur = current();
      if (!cur || cur.messages.length) { const c = createChat(); currentId = c.id; }
      show('chat');
      $('#input').focus();
      break;
    }
    case 'show-chat': show('chat'); break;
    case 'show-settings': show('settings'); break;
    case 'show-multi': show('multi'); break;
    case 'open-chat': currentId = id; show('chat'); break;
    case 'delete-chat': deleteChat(id); break;
    case 'open-model': openModelDialog(); break;
    case 'md-fetch': mdFetch(); break;
    case 'close-dialog': b.closest('dialog').close(); break;
    case 'copy-msg': {
      const m = current()?.messages[Number(b.dataset.i)];
      if (m) copyText(m.content);
      break;
    }
    case 'retry': retry(Number(b.dataset.i)); break;
    case 'add-conn': openConnDialog(null); break;
    case 'add-conn-direct': show('settings'); openConnDialog(null); break;
    case 'edit-conn': openConnDialog(id); break;
    case 'default-conn': settings.defaultConnectionId = id; persistSettings(); renderSettings(); break;
    case 'delete-conn': {
      const c = conn(id);
      if (c && confirm(`"${c.name}" हटाएँ? इसकी key भी इस फ़ोन से हट जाएगी।`)) {
        settings.connections = settings.connections.filter(x => x.id !== id);
        if (settings.defaultConnectionId === id) settings.defaultConnectionId = settings.connections[0]?.id || null;
        persistSettings();
        renderSettings();
        renderTopbar();
      }
      break;
    }
    case 'cd-toggle-key': {
      const k = $('#cdKey');
      k.type = k.type === 'password' ? 'text' : 'password';
      b.textContent = k.type === 'password' ? 'दिखाएँ' : 'छिपाएँ';
      break;
    }
    case 'cd-fetch': cdFetch(); break;
    case 'cd-test': cdTest(); break;
    case 'export': exportChats(); break;
    case 'clear-chats':
      if (confirm('सारी चैट हटाएँ? यह वापस नहीं होगा।')) {
        abortAll();
        chats = [];
        currentId = null;
        batch = null;
        clearFiles().catch(() => {});
        persistChats(true);
        renderChatList();
        toast('सारी चैट हटा दी गईं।');
      }
      break;
    case 'clear-all':
      if (confirm('सारी चैट और सारी API keys इस फ़ोन से हटाएँ?')) {
        abortAll();
        clearAll();
        clearFiles().catch(() => {});
        settings = loadSettings();
        chats = [];
        currentId = null;
        batch = null;
        renderSettings();
        renderChatList();
        renderTopbar();
        toast('सब कुछ हटा दिया गया।');
      }
      break;
    case 'install': closeDrawer(); installApp(); break;
    case 'copy-link': copyText(location.href.split('#')[0]); break;
    case 'mt-add-target': {
      const d = defaultConn();
      multiDraft.targets.push({ connectionId: d.id, model: '' });
      renderMulti();
      break;
    }
    case 'mt-remove-target':
      multiDraft.targets.splice(Number(b.dataset.i), 1);
      renderMulti();
      break;
    case 'mt-run': runBatch(); break;
    case 'attach': $('#fileInput').click(); break;
    case 'remove-file': {
      const [a] = pendingFiles.splice(Number(b.dataset.i), 1);
      if (a && !a.loading) deleteFiles([a.id]).catch(() => {});
      renderAttachRow();
      break;
    }
    case 'mt-stop':
      if (batch) for (const cid of batch.chatIds) running.get(cid)?.controller.abort();
      break;
    default: break;
  }
}

// Chrome's "Desktop site" mode ignores the viewport tag and lays the page out
// ~980px wide, so on a phone everything looks tiny. Detect that and scale the
// app back up to the phone's real width, with the phone layout.
function fitPhoneInDesktopMode() {
  const root = document.documentElement;
  const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  const sw = screen.width;
  const ratio = window.innerWidth / sw;
  const on = touch && sw > 0 && sw < 700 && ratio > 1.3;
  root.classList.toggle('force-mobile', on);
  root.style.zoom = on ? String(ratio) : '';
  root.style.setProperty('--app-h', on ? `${window.innerHeight / ratio}px` : '');
}

function init() {
  fitPhoneInDesktopMode();
  window.addEventListener('resize', fitPhoneInDesktopMode);
  document.addEventListener('click', onClick);
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.classList.contains('team-contributions')) {
      const message = current()?.messages[Number(d.dataset.mi)];
      if (message) message.teamOpen = d.open;
      return;
    }
    if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('tool')) return;
    const part = current()?.messages[Number(d.dataset.mi)]?.parts?.[Number(d.dataset.pi)];
    if (part) part.open = d.open;
  }, true);
  $('#composer').addEventListener('submit', onSubmit);
  $('#fileInput').addEventListener('change', e => {
    const list = [...e.target.files];
    e.target.value = '';
    onFilesPicked(list);
  });
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !coarsePointer && !e.isComposing) {
      e.preventDefault();
      $('#composer').requestSubmit();
    }
  });
  $('#modelForm').addEventListener('submit', saveModelDialog);
  $('#teamForm').addEventListener('submit', saveTeamDialog);
  $('#teamMembers').addEventListener('change', e => {
    if (!e.target.matches('[data-team-conn]')) return;
    readTeamDraft();
    const i = Number(e.target.dataset.teamConn);
    const c = conn(teamDraft.members[i].connectionId);
    teamDraft.members[i].model = [c?.defaultModel, ...(c?.models || [])].find(m => m && TEAM_ROLES[i].match.test(m)) || '';
    renderTeamMembers();
  });
  $('#mdConn').addEventListener('change', () => {
    const c = conn($('#mdConn').value);
    $('#mdModel').value = c?.defaultModel || '';
    $('#mdStatus').textContent = '';
    syncModelDialogModels();
  });
  $('#connForm').addEventListener('submit', saveConnDialog);
  $('#cdPreset').addEventListener('change', e => {
    const p = PRESETS.find(x => x.id === e.target.value);
    if (p) applyPreset(p);
  });
  $('#cdFormat').addEventListener('change', syncFormatFields);
  $('#cdKey').addEventListener('input', onKeyInput);

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    syncInstallButtons();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    deferredInstall = null;
    syncInstallButtons();
    toast('✓ ऐप इंस्टॉल हो गया। अब होम स्क्रीन से खोलें।');
  });
  $('#installForm').addEventListener('submit', e => e.preventDefault());

  if (!currentId) {
    const c = createChat();
    currentId = c.id;
  }
  show('chat');
  syncInstallButtons();

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  startAutoUpdate();
}

init();
