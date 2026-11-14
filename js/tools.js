// Tools the model can call while answering: web search, reading a web page,
// and running JavaScript or Python. Each tool returns plain text for the model.

const MAX_TOOL_TEXT = 15000;

export const TOOL_DEFS = {
  web_search: {
    label: 'वेब खोज',
    icon: '🔎',
    setting: 'search',
    description: 'Search the web for current or factual information. Returns titles, links and short text for the top results. Use read_webpage to read a result in full.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query, in the language most likely to find good results.' } },
      required: ['query'],
    },
  },
  read_webpage: {
    label: 'पेज पढ़ा',
    icon: '📄',
    setting: 'read',
    description: 'Read the main text of a web page (as Markdown). Use it to open search results or links the user gives.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full http(s) URL of the page.' } },
      required: ['url'],
    },
  },
  run_javascript: {
    label: 'JavaScript चलाया',
    icon: '▶',
    setting: 'js',
    description: 'Run JavaScript in a sandboxed worker (no DOM; fetch is available) to calculate, transform data or test code. Use console.log for output or `return` a value. 15 second limit.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript source. Top-level await is allowed.' } },
      required: ['code'],
    },
  },
  run_python: {
    label: 'Python चलाया',
    icon: '🐍',
    setting: 'python',
    description: 'Run Python 3 (Pyodide, in the browser) to calculate, analyse data, process files or test code. Use print() for output; the last expression is also returned. Packages from the Pyodide distribution (numpy, pandas, matplotlib, Pillow, etc.) load automatically on import; pure-Python packages from PyPI can be installed with `import micropip; await micropip.install("name")`. Files the user uploaded in this chat are in /home/pyodide/uploads/. There is no ffmpeg or system shell. Variables persist between runs. The first run downloads Python (about 10 MB).',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Python source.' } },
      required: ['code'],
    },
  },
};

export const DEFAULT_TOOL_SETTINGS = {
  enabled: true,
  search: true,
  read: true,
  js: true,
  python: true,
  tavilyKey: '',
  jinaKey: '',
};

export function toolSettings(settings) {
  return { ...DEFAULT_TOOL_SETTINGS, ...(settings.tools || {}) };
}

export function enabledTools(settings) {
  const t = toolSettings(settings);
  if (!t.enabled) return [];
  return Object.entries(TOOL_DEFS)
    .filter(([, d]) => t[d.setting])
    .map(([name, d]) => ({ name, description: d.description, parameters: d.parameters }));
}

export function toolSystemPrompt(settings) {
  const tools = enabledTools(settings).map(t => t.name);
  if (!tools.length) return '';
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return [
    `Today's date is ${date}.`,
    `You can call these tools: ${tools.join(', ')}.`,
    'Use web_search (then read_webpage when needed) for anything recent, factual or that you are unsure of, and mention the sources you used.',
    'Use run_javascript or run_python to calculate, process data or check code instead of guessing.',
    'Reply in the language the user writes in.',
  ].join(' ');
}

function clip(text, n = MAX_TOOL_TEXT) {
  const s = String(text ?? '');
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more characters cut]` : s;
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function fetchOk(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`HTTP ${res.status} ${body}`.trim());
  }
  return res;
}

// ---------- web search ----------

// Wikimedia asks API clients to identify themselves; browsers can't set
// User-Agent, so Api-User-Agent is the documented alternative. One retry on 429.
const WIKI_HEADERS = { 'Api-User-Agent': 'ReaStudio/1.0 (open-source PWA chat client)' };
async function wikiJson(url, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await (await fetchOk(url, { headers: WIKI_HEADERS, signal })).json();
    } catch (e) {
      if (!/HTTP 429/.test(e.message)) throw e;
      if (attempt > 0) {
        throw new Error('Wikipedia is rate-limiting requests right now (HTTP 429). Try again in a minute, or the user can add a Tavily or Jina key in the app settings for full web search.');
      }
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

async function searchWikipedia(query, signal) {
  const langs = /[ऀ-ॿ]/.test(query) ? ['hi', 'en'] : ['en'];
  const lines = [];
  for (const lang of langs) {
    const base = `https://${lang}.wikipedia.org/w/api.php?format=json&origin=*`;
    const s = await wikiJson(`${base}&action=query&list=search&srlimit=5&srsearch=${encodeURIComponent(query)}`, signal);
    const hits = s?.query?.search || [];
    if (!hits.length) continue;
    const titles = hits.slice(0, 3).map(h => h.title);
    let extracts = {};
    try {
      const x = await wikiJson(`${base}&action=query&prop=extracts&exintro=1&explaintext=1&exchars=1200&redirects=1&titles=${encodeURIComponent(titles.join('|'))}`, signal);
      for (const p of Object.values(x?.query?.pages || {})) extracts[p.title] = p.extract;
    } catch { /* snippets are enough */ }
    hits.forEach((h, i) => {
      const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, '_'))}`;
      lines.push(`${lines.length + 1}. ${h.title}\n${url}\n${(extracts[h.title] || stripHtml(h.snippet)).trim()}`);
    });
  }
  if (!lines.length) return `No Wikipedia results for "${query}".`;
  return 'Source: Wikipedia (add a Tavily or Jina key in the app settings for full web search).\n\n' + lines.join('\n\n');
}

async function searchTavily(query, key, signal) {
  const j = await (await fetchOk('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 6, search_depth: 'basic', include_answer: false }),
    signal,
  })).json();
  const r = j.results || [];
  if (!r.length) return `No results for "${query}".`;
  return r.map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${clip(x.content, 1500)}`).join('\n\n');
}

async function searchJina(query, key, signal) {
  const j = await (await fetchOk(`https://s.jina.ai/?q=${encodeURIComponent(query)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal,
  })).json();
  const r = j.data || [];
  if (!r.length) return `No results for "${query}".`;
  return r.slice(0, 6).map((x, i) => `${i + 1}. ${x.title}\n${x.url}\n${clip(x.description || x.content, 1500)}`).join('\n\n');
}

async function webSearch(args, t, signal) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query is empty');
  if (t.tavilyKey) return searchTavily(query, t.tavilyKey, signal);
  if (t.jinaKey) return searchJina(query, t.jinaKey, signal);
  return searchWikipedia(query, signal);
}

// ---------- read a page ----------

async function readWebpage(args, t, signal) {
  const url = String(args.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
  const headers = { Accept: 'text/plain' };
  if (t.jinaKey) headers.Authorization = `Bearer ${t.jinaKey}`;
  const res = await fetchOk(`https://r.jina.ai/${url}`, { headers, signal });
  return clip(await res.text());
}

// ---------- run code ----------

function runInWorker(worker, code, timeoutMs, signal, files = []) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const timer = setTimeout(() => { done(); reject(Object.assign(new Error(`समय सीमा (${timeoutMs / 1000} सेकंड) पार हो गई`), { kill: true })); }, timeoutMs);
    const onAbort = () => { done(); reject(Object.assign(new DOMException('Aborted', 'AbortError'), { kill: true })); };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = e => { done(); resolve(e.data); };
    worker.onerror = e => { done(); reject(Object.assign(new Error(e.message || 'worker error'), { kill: true })); };
    worker.postMessage({ code, files }, files.map(f => f.buf));
  });
}

function formatRun(r) {
  const parts = [];
  if (r.logs?.length) parts.push(r.logs.join('\n'));
  if (r.ok && r.result !== null && r.result !== undefined && r.result !== '') parts.push(`Result: ${r.result}`);
  if (!r.ok) parts.push(r.error);
  return { ok: r.ok, text: clip(parts.join('\n') || '(no output)') };
}

async function runJavascript(args, signal) {
  const worker = new Worker(new URL('./run-worker.js', import.meta.url));
  try {
    return formatRun(await runInWorker(worker, String(args.code || ''), 15000, signal));
  } finally {
    worker.terminate();
  }
}

let pyWorker = null;
let pyStarted = false;
let pySent = new Set(); // uploaded files already copied into the current Python worker
let pythonQueue = Promise.resolve();
function runPython(args, signal, ctx) {
  // Team members and ordinary chats share one Python worker. Never replace
  // its message handler while another run is waiting for a result.
  const job = pythonQueue.then(() => {
    signal?.throwIfAborted();
    return runPythonExclusive(args, signal, ctx);
  });
  pythonQueue = job.catch(() => {});
  if (!signal) return job;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function runPythonExclusive(args, signal, ctx) {
  // Files the user uploaded in this chat are copied into Python's file system.
  if (!pyWorker) {
    pyWorker = new Worker(new URL('./py-worker.js', import.meta.url), { type: 'module' });
    pyStarted = false;
    pySent = new Set();
  }
  const files = [];
  for (const f of (ctx && ctx.files ? await ctx.files() : [])) {
    if (pySent.has(f.id)) continue;
    files.push({ id: f.id, name: f.name, buf: await f.blob.arrayBuffer() });
    pySent.add(f.id);
  }
  const timeout = pyStarted ? 60000 : 180000; // first run downloads Python
  try {
    const r = await runInWorker(pyWorker, String(args.code || ''), timeout, signal, files);
    pyStarted = true;
    return formatRun(r);
  } catch (e) {
    if (e.kill) { pyWorker.terminate(); pyWorker = null; }
    throw e;
  }
}

// ---------- dispatch ----------

export function toolLabel(name, args) {
  const d = TOOL_DEFS[name];
  const detail = name === 'web_search' ? args.query : name === 'read_webpage' ? args.url : '';
  return { icon: d?.icon || '🛠', label: d?.label || name, detail: detail || '' };
}

export async function runTool(name, args, settings, signal, ctx) {
  const t = toolSettings(settings);
  const def = TOOL_DEFS[name];
  if (!def || !t.enabled || !t[def.setting]) return { ok: false, text: `Tool "${name}" is not available.` };
  try {
    if (name === 'web_search') return { ok: true, text: await webSearch(args, t, signal) };
    if (name === 'read_webpage') return { ok: true, text: await readWebpage(args, t, signal) };
    if (name === 'run_javascript') return await runJavascript(args, signal);
    if (name === 'run_python') return await runPython(args, signal, ctx);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    const msg = e?.name === 'TypeError' ? `Network error (${e.message})` : e?.message || String(e);
    return { ok: false, text: `Error: ${msg}` };
  }
  return { ok: false, text: `Unknown tool "${name}".` };
}
