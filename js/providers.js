// Talks to AI providers directly from the browser. Two wire formats are
// supported: OpenAI-style `/chat/completions` (used by most providers) and
// Anthropic-style `/v1/messages`. The API key goes only to the base URL the
// user configured for that connection.

export const FORMATS = {
  openai: 'OpenAI-जैसा (chat/completions)',
  anthropic: 'Anthropic-जैसा (messages)',
};

const COARENA_MODELS = [
  'claude-fable-5', 'claude-fable-5-1', 'claude-fable-5-2', 'claude-haiku-5-5',
  'claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-v4-1-flash-1017', 'gemini-3-8-flash',
  'gemini-4-argon', 'gemini-4-carbon', 'glm-5-3-flash', 'gpt-6-1-sol', 'gpt-6-1-terra',
  'gpt-6-astra', 'gpt-6-luna', 'grok-4-7', 'hy4', 'kimi-k3', 'kimi-k3-1-pro',
  'mimo-v2-6-pro', 'minimax-m3-1-flash', 'qwen3-8-2-4t-a95b',
];

export const PRESETS = [
  {
    id: 'coarena', name: 'Coarena', format: 'openai', baseUrl: 'https://coarena.ai/api/v1', keyPrefix: 'coa_',
    models: COARENA_MODELS, defaultModel: 'claude-sonnet-5-5', maxParallel: 2,
    hint: 'Coarena के docs: रोज़ $5 तक मुफ्त, एक मिनट में 30 और एक साथ 2 requests। यह site आपके requests का रिकॉर्ड रखती है — निजी जानकारी न डालें।',
  },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', format: 'anthropic',
    baseUrl: 'https://api.anthropic.com', anthropicVersion: '2026-10-21', keyPrefix: 'sk-ant-',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'],
    defaultModel: 'claude-sonnet-5-5', maxTokens: 64000, maxParallel: 4,
    hint: 'Key: platform.claude.com → API Keys। यह API अलग से billed होता है।',
  },
  {
    id: 'openai', name: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1',
    maxParallel: 4, hint: 'Key: platform.openai.com → API keys।',
  },
  {
    id: 'openrouter', name: 'OpenRouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyPrefix: 'sk-or-',
    maxParallel: 4, hint: 'Key: openrouter.ai → Keys। कई मॉडल एक key से; कुछ मॉडल ":free" वाले होते हैं।',
  },
  {
    id: 'gemini', name: 'Google Gemini', format: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyPrefix: 'AIza',
    maxParallel: 3, hint: 'Key: aistudio.google.com → Get API key।',
  },
  {
    id: 'groq', name: 'Groq', format: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyPrefix: 'gsk_',
    maxParallel: 3, hint: 'Key: console.groq.com → API Keys।',
  },
  {
    id: 'deepseek', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    maxParallel: 3, hint: 'Key: platform.deepseek.com → API keys।',
  },
  {
    id: 'mistral', name: 'Mistral', format: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    maxParallel: 3, hint: 'Key: console.mistral.ai → API Keys।',
  },
  {
    id: 'xai', name: 'xAI (Grok)', format: 'openai', baseUrl: 'https://api.x.ai/v1', keyPrefix: 'xai-',
    maxParallel: 3, hint: 'Key: console.x.ai।',
  },
  {
    id: 'together', name: 'Together AI', format: 'openai', baseUrl: 'https://api.together.xyz/v1',
    maxParallel: 3, hint: 'Key: api.together.ai → Settings → API Keys।',
  },
  {
    id: 'custom-openai', name: 'कोई और (OpenAI-जैसा API)', format: 'openai', baseUrl: '',
    maxParallel: 3, hint: 'ज़्यादातर providers यही format देते हैं। Base URL आमतौर पर /v1 पर खत्म होता है।',
  },
  {
    id: 'custom-anthropic', name: 'कोई और (Anthropic-जैसा API)', format: 'anthropic', baseUrl: '',
    anthropicVersion: '2023-06-01', maxTokens: 16000, maxParallel: 3,
    hint: 'Anthropic-compatible सेवाओं के लिए। Base URL में /v1/messages न जोड़ें, वह अपने आप जुड़ता है।',
  },
];

// Recognise a provider from its API key's well-known prefix.
export function presetForKey(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return PRESETS.find(p => p.keyPrefix && k.startsWith(p.keyPrefix)) || null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

// Returns the matching preset when the key clearly belongs to a different
// provider than the connection's base URL points at; otherwise null.
export function keyMismatch(conn) {
  const p = presetForKey(conn.apiKey);
  if (!p) return null;
  return hostOf(p.baseUrl) === hostOf(conn.baseUrl) ? null : p;
}

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function trimSlash(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

export function endpoints(conn) {
  const base = trimSlash(conn.baseUrl);
  if (conn.format === 'anthropic') {
    const root = /\/v1$/.test(base) ? base : base + '/v1';
    return { chat: root + '/messages', models: root + '/models' };
  }
  return { chat: base + '/chat/completions', models: base + '/models' };
}

function headersFor(conn) {
  const h = { 'Content-Type': 'application/json' };
  if (conn.format === 'anthropic') {
    if (conn.apiKey) h['x-api-key'] = conn.apiKey;
    h['anthropic-version'] = conn.anthropicVersion || '2023-06-01';
    // Required by api.anthropic.com for requests made directly from a browser.
    h['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (conn.apiKey) {
    h.Authorization = 'Bearer ' + conn.apiKey;
  }
  return h;
}

function statusMessage(s) {
  if (s === 401 || s === 403) return 'API key गलत है, किसी दूसरे provider की है, या इसे यह काम करने की अनुमति नहीं है।';
  if (s === 404) return 'Base URL या मॉडल का नाम गलत है।';
  if (s === 400 || s === 422) return 'Provider ने request नहीं मानी। मॉडल का नाम या max tokens जाँचें।';
  if (s === 402) return 'इस account में credit/balance नहीं बचा।';
  if (s === 408 || s === 504) return 'Provider ने समय पर जवाब नहीं दिया।';
  if (s === 429) return 'लिमिट पूरी हो गई या बहुत तेज़ requests भेजी गईं। थोड़ी देर बाद फिर कोशिश करें।';
  if (s === 529) return 'Provider अभी बहुत व्यस्त है। थोड़ी देर बाद फिर कोशिश करें।';
  if (s >= 500) return 'Provider की तरफ से दिक्कत है। थोड़ी देर बाद फिर कोशिश करें।';
  return `Request में त्रुटि (${s})।`;
}

async function readError(res) {
  let detail = '';
  try {
    detail = await res.text();
    const j = JSON.parse(detail);
    detail = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '') || detail;
  } catch {
    // keep raw text
  }
  return new ApiError(statusMessage(res.status), res.status, String(detail).slice(0, 600));
}

export function friendlyError(e) {
  if (e instanceof ApiError) return { title: e.message, detail: e.detail || '', status: e.status };
  if (e && e.name === 'TypeError') {
    return {
      title: 'नेटवर्क त्रुटि: इंटरनेट बंद है, Base URL गलत है, या यह provider ब्राउज़र से सीधी request (CORS) स्वीकार नहीं करता।',
      detail: e.message || '',
    };
  }
  return { title: e?.message || 'कुछ गलत हो गया।', detail: '' };
}

// Minimal Server-Sent Events reader over a fetch Response body.
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = null;
  let data = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = null;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c === -1 ? line : line.slice(0, c);
        let val = c === -1 ? '' : line.slice(c + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.cancel().catch(() => {});
  }
}

// Merge consecutive same-role turns and drop empty ones, so a failed reply
// in the middle of a chat doesn't break providers that require alternation.
function normalize(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (!m.content || !m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

function parseArgs(s) {
  if (!s || !String(s).trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return { _raw: String(s) };
  }
}

// Builds the provider-native messages that report tool results back.
export function toolResultMessages(format, results) {
  if (format === 'anthropic') {
    return [{
      role: 'user',
      content: results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, ...(r.ok ? {} : { is_error: true }) })),
    }];
  }
  return results.map(r => ({ role: 'tool', tool_call_id: r.id, content: r.text }));
}

function fromJson(conn, j) {
  if (conn.format === 'anthropic') {
    const content = (j.content || []).filter(b => b.type !== 'text' || b.text);
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolCalls = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { text, toolCalls, stopReason: j.stop_reason || null, assistantMessage: { role: 'assistant', content } };
  }
  const c = j.choices?.[0];
  const m = c?.message || {};
  const calls = (m.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function?.name, args: parseArgs(tc.function?.arguments) }));
  const assistantMessage = { role: 'assistant', content: m.content || null };
  if (m.tool_calls?.length) assistantMessage.tool_calls = m.tool_calls;
  return { text: m.content || '', toolCalls: calls, stopReason: c?.finish_reason || null, assistantMessage };
}

// One request to the model. `history` is the chat as {role, content} text
// turns; `trail` holds provider-native messages from earlier tool rounds of
// this same reply. Returns the text, any tool calls the model made, and the
// assistant message to append to the trail before sending tool results.
export async function streamTurn({ conn, model, system, history, trail = [], tools = null, signal, onText }) {
  const msgs = normalize(history);
  if (!msgs.length) throw new ApiError('भेजने के लिए कोई संदेश नहीं है।', 0, '');
  const sys = (system || '').trim();
  const anth = conn.format === 'anthropic';
  let body;
  if (anth) {
    body = { model, max_tokens: Number(conn.maxTokens) || 16000, messages: msgs.concat(trail), stream: true };
    if (sys) body.system = sys;
    if (tools?.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  } else {
    body = { model, messages: (sys ? [{ role: 'system', content: sys }] : []).concat(msgs, trail), stream: true };
    if (Number(conn.maxTokens) > 0) body.max_tokens = Number(conn.maxTokens);
    if (tools?.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
  }

  const res = await fetch(endpoints(conn).chat, {
    method: 'POST',
    headers: headersFor(conn),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await readError(res);

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    // Some providers ignore `stream: true` and answer with plain JSON.
    const j = await res.json();
    if (j.error) throw new ApiError('Provider ने त्रुटि भेजी।', 0, j.error.message || JSON.stringify(j.error));
    const r = fromJson(conn, j);
    if (r.text) onText(r.text);
    return r;
  }

  let stopReason = null;
  let text = '';
  const blocks = []; // anthropic content blocks, by index
  const calls = []; // openai tool calls, by index
  const emit = t => { text += t; onText(t); };

  for await (const ev of sseEvents(res)) {
    if (ev.data === '[DONE]') break;
    let j;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    if (anth) {
      if (j.type === 'content_block_start') {
        const b = { ...j.content_block };
        if (b.type === 'tool_use') { b.input = {}; b._json = ''; }
        if (b.type === 'text') b.text = '';
        if (b.type === 'thinking') { b.thinking = b.thinking || ''; b.signature = b.signature || ''; }
        blocks[j.index] = b;
      } else if (j.type === 'content_block_delta') {
        const b = blocks[j.index];
        const d = j.delta || {};
        if (d.type === 'text_delta') {
          if (b) b.text += d.text || '';
          if (d.text) emit(d.text);
        } else if (b && d.type === 'input_json_delta') b._json += d.partial_json || '';
        else if (b && d.type === 'thinking_delta') b.thinking += d.thinking || '';
        else if (b && d.type === 'signature_delta') b.signature += d.signature || '';
      } else if (j.type === 'content_block_stop') {
        const b = blocks[j.index];
        if (b && b.type === 'tool_use') { b.input = parseArgs(b._json); delete b._json; }
      } else if (j.type === 'message_delta') {
        stopReason = j.delta?.stop_reason || stopReason;
      } else if (j.type === 'error') {
        const status = j.error?.type === 'overloaded_error' ? 529 : j.error?.type === 'rate_limit_error' ? 429 : 500;
        throw new ApiError(statusMessage(status), status, j.error?.message || '');
      } else if (j.type === 'message_stop') {
        break;
      }
    } else {
      if (j.error) {
        throw new ApiError('Provider ने जवाब के बीच में त्रुटि भेजी।', 0, j.error.message || JSON.stringify(j.error));
      }
      const c = j.choices?.[0];
      const d = c?.delta || {};
      if (typeof d.content === 'string' && d.content) emit(d.content);
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        const call = (calls[i] ||= { id: '', name: '', args: '' });
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (c?.finish_reason) stopReason = c.finish_reason;
    }
  }

  if (anth) {
    const content = blocks.filter(b => b && (b.type !== 'text' || b.text));
    for (const b of content) if (b.type === 'tool_use' && b._json !== undefined) { b.input = parseArgs(b._json); delete b._json; }
    const toolCalls = content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} }));
    return { text, toolCalls, stopReason, assistantMessage: { role: 'assistant', content } };
  }
  const list = calls.filter(c => c && c.name);
  list.forEach((c, i) => { if (!c.id) c.id = `call_${Date.now().toString(36)}_${i}`; });
  const assistantMessage = { role: 'assistant', content: text || null };
  if (list.length) {
    assistantMessage.tool_calls = list.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
  }
  return { text, toolCalls: list.map(c => ({ id: c.id, name: c.name, args: parseArgs(c.args) })), stopReason, assistantMessage };
}

// Plain streaming chat without tools (used by the connection test).
export async function streamChat({ conn, model, system, messages, signal, onDelta }) {
  const r = await streamTurn({ conn, model, system, history: messages, signal, onText: onDelta });
  return { stopReason: r.stopReason };
}

export async function listModels(conn, signal) {
  const res = await fetch(endpoints(conn).models, { headers: headersFor(conn), signal });
  if (!res.ok) throw await readError(res);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : j.data || j.models || [];
  const ids = arr
    .map(m => (typeof m === 'string' ? m : m.id || m.name))
    .filter(Boolean)
    .map(s => String(s).replace(/^models\//, ''));
  return [...new Set(ids)].sort();
}
