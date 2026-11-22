// A small project workspace stored with the current team conversation.
const MAX_FILE = 100000;
const MAX_TOTAL = 600000;
const MAX_FILES = 30;
export const PROJECT_TOOLS = [
  { name: 'project_list', description: 'List files in this shared project.', parameters: { type: 'object', properties: {} } },
  { name: 'project_read', description: 'Read a text file in the shared project. Read before editing an existing file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'project_write', description: 'Create or replace an entire UTF-8 text file in the shared project. For a runnable web preview use index.html and optional style.css and script.js. This does not write to the user device or publish a website.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
];
export function filesOf(chat) {
  if (!chat.workspace || typeof chat.workspace !== 'object') chat.workspace = { files: {} };
  if (!chat.workspace.files || typeof chat.workspace.files !== 'object') chat.workspace.files = {};
  return chat.workspace.files;
}
export function safePath(path) {
  const p = String(path || '').trim();
  if (!p || p.length > 120 || !/^[a-zA-Z0-9_.\-/]+$/.test(p) || p.startsWith('/') || p.split('/').some(x => !x || x === '.' || x === '..' || ['__proto__', 'constructor', 'prototype'].includes(x))) throw new Error('फ़ाइल का सही नाम डालें, जैसे index.html।');
  return p;
}
export function writeProject(chat, path, content) {
  const p = safePath(path);
  if (typeof content !== 'string') throw new Error('फ़ाइल का content text होना चाहिए।');
  if (content.length > MAX_FILE) throw new Error('फ़ाइल 100,000 अक्षरों से बड़ी है।');
  const files = filesOf(chat);
  if (!Object.hasOwn(files, p) && Object.keys(files).length >= MAX_FILES) throw new Error('प्रोजेक्ट में अधिकतम 30 फ़ाइलें हैं।');
  const total = Object.entries(files).reduce((n, [k, v]) => n + (k === p ? 0 : String(v).length), 0) + content.length;
  if (total > MAX_TOTAL) throw new Error('प्रोजेक्ट स्टोरेज सीमा पूरी हो गई।');
  files[p] = content;
  return p;
}
export function projectTool(chat, name, args) {
  const files = filesOf(chat);
  if (name === 'project_list') return { ok: true, text: JSON.stringify(Object.keys(files)) };
  if (name === 'project_read') {
    const p = safePath(args.path);
    return Object.hasOwn(files, p) ? { ok: true, text: files[p] } : { ok: false, text: `फ़ाइल नहीं मिली: ${p}` };
  }
  if (name === 'project_write') { const p = writeProject(chat, args.path, args.content); return { ok: true, text: `Saved ${p} in the shared project.` }; }
  return { ok: false, text: 'Unknown project tool.' };
}
export function projectContext(chat) {
  const files = filesOf(chat);
  return JSON.stringify(Object.entries(files).map(([path, value]) => ({ path, content: value.slice(0, 30000), truncated: value.length > 30000 })));
}
// Scripts run in an opaque-origin sandbox with network access blocked. This is
// an HTML/CSS/JS preview, not a Python/Node process or arbitrary local browser.
export function previewDocument(chat) {
  const files = filesOf(chat);
  let html = files['index.html'];
  if (html === undefined) return '<p>पहले index.html बनाएँ।</p>';
  html = html.replace(/<link\b[^>]*href=["'](?:\.\/)?style\.css["'][^>]*>/gi, () => `<style>${files['style.css'] || ''}</style>`);
  html = html.replace(/<script\b[^>]*src=["'](?:\.\/)?script\.js["'][^>]*>\s*<\/script>/gi, () => `<script>${files['script.js'] || ''}</script>`);
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'">${html}`;
}
