// Local persistence. Everything stays in this browser's localStorage on the
// user's own device; nothing is sent to any server by this module.

const KEY_SETTINGS = 'rea.v1.settings';
const KEY_CHATS = 'rea.v1.chats';

export function uid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function loadSettings() {
  const s = read(KEY_SETTINGS, null) || {};
  return {
    connections: Array.isArray(s.connections) ? s.connections : [],
    defaultConnectionId: s.defaultConnectionId || null,
    systemPrompt: typeof s.systemPrompt === 'string' ? s.systemPrompt : '',
    tools: s.tools && typeof s.tools === 'object' ? s.tools : {},
  };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function loadChats() {
  const chats = read(KEY_CHATS, []);
  if (!Array.isArray(chats)) return [];
  // A reply that was still streaming when the page closed can't resume.
  for (const chat of chats) {
    for (const m of chat.messages || []) {
      if (m.pending) {
        delete m.pending;
        if (!m.content) m.stopped = true;
        if (m.teamRuns) {
          m.teamPhase = 'stopped';
          m.stopped = true;
          for (const r of m.teamRuns) {
            if (!r) continue;
            if (['queued', 'working'].includes(r.status)) r.status = 'stopped';
            for (const s of r.steps || []) if (s.status === 'working') s.status = 'stopped';
          }
        }
      }
    }
  }
  return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function saveChats(chats) {
  try {
    localStorage.setItem(KEY_CHATS, JSON.stringify(chats));
    return true;
  } catch {
    return false;
  }
}

export function clearAll() {
  localStorage.removeItem(KEY_SETTINGS);
  localStorage.removeItem(KEY_CHATS);
}
