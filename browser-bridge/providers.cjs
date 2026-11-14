'use strict';

// These are the official websites, not API model aliases. Selectors can
// change; if they don't match we report an error, never substitute an API.
const SERVICES = Object.freeze({
  chatgpt: {
    name: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com', 'chat.openai.com'],
    inputs: ['#prompt-textarea', '#mobile-composer-prompt', '[data-testid="prompt-textarea"]', 'textarea[data-id="root"]'],
    sends: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]'],
    answers: ['[data-message-author-role="assistant"]', '[data-assistant-markdown-root]'],
    stops: ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="रोक"]'],
  },
  gemini: {
    name: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'],
    inputs: ['rich-textarea [role="textbox"][contenteditable="true"]', '[role="textbox"][contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
    sends: ['button.send-button', 'button[aria-label="Send message"]', 'button[aria-label="Send"]'],
    answers: ['model-response message-content', 'model-response', '[data-test-id="model-response"]'],
    stops: ['button[aria-label*="Stop"]', 'button[aria-label*="रोक"]', 'button.stop-button'],
  },
  claude: {
    name: 'Claude', url: 'https://claude.ai/', hosts: ['claude.ai', 'claude.com'],
    inputs: ['[data-testid="chat-input"] [contenteditable="true"]', '[data-testid="chat-input"][contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]'],
    sends: ['button[data-testid="send-button"]', 'button[aria-label="Send message"]', 'button[aria-label="Send Message"]'],
    answers: ['[data-testid="assistant-message"]', '[data-is-streaming] .font-claude-response', '.font-claude-response'],
    stops: ['button[aria-label*="Stop"]', 'button[aria-label*="रोक"]', 'button[data-testid="stop-button"]'],
  },
});

const WAIT_MS = 180000;
const SETTLE_MS = 5000;
const POLL_MS = 500;

function assertOfficialHost(url, service) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('वेबसाइट अभी नहीं खुली है।'); }
  if (parsed.protocol !== 'https:' || !service.hosts.includes(parsed.hostname)) {
    throw new Error(`${service.name} का चैट पेज खोलकर लॉगिन पूरा करें।`);
  }
}

async function firstVisible(page, selectors, editable = false) {
  for (const selector of selectors) {
    const nodes = page.locator(selector);
    const count = await nodes.count();
    for (let i = count - 1; i >= 0; i--) {
      const node = nodes.nth(i);
      try { if (await node.isVisible() && (!editable || await node.isEditable())) return node; }
      catch { /* page changed; try next candidate */ }
    }
  }
  return null;
}

async function answerSnapshot(page, selectors) {
  for (const selector of selectors) {
    const nodes = page.locator(selector);
    const count = await nodes.count();
    if (count) return { selector, count, text: (await nodes.last().innerText().catch(() => '')).trim() };
  }
  return { selector: selectors[0], count: 0, text: '' };
}

function abortError(signal) { return signal?.reason || new DOMException('Aborted', 'AbortError'); }
async function pause(ms, signal) {
  if (signal?.aborted) throw abortError(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    const cancel = () => { clearTimeout(timer); reject(abortError(signal)); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function submitPrompt(page, service, prompt, { signal, timeoutMs = WAIT_MS, settleMs = SETTLE_MS, pollMs = POLL_MS, verifyHost = true } = {}) {
  if (verifyHost) assertOfficialHost(page.url(), service);
  if (signal?.aborted) throw abortError(signal);
  const editor = await firstVisible(page, service.inputs, true);
  if (!editor) throw new Error(`${service.name} का संदेश लिखने का स्थान नहीं मिला। लॉगिन या साइट की स्क्रीन जाँचें।`);
  const before = {};
  for (const selector of service.answers) before[selector] = await page.locator(selector).count();
  await editor.fill(prompt, { timeout: 10000 });
  const send = await firstVisible(page, service.sends);
  if (send && await send.isEnabled()) await send.click({ timeout: 10000 });
  else await editor.press('Enter', { timeout: 10000 });
  const deadline = Date.now() + timeoutMs;
  let previous = '', stableSince = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw abortError(signal);
    if (verifyHost) assertOfficialHost(page.url(), service);
    const now = await answerSnapshot(page, service.answers);
    // Require a new assistant message; don't present a stale or user message.
    if (now.count > (before[now.selector] || 0) && now.text) {
      const stopped = await firstVisible(page, service.stops);
      if (now.text !== previous) { previous = now.text; stableSince = Date.now(); }
      else if (!stopped && stableSince && Date.now() - stableSince >= settleMs) {
        // Gemini's outer accessibility container can prefix its own label.
        const text = service.name === 'Gemini' && now.selector === 'model-response'
          ? now.text.replace(/^Gemini said\s*\n+/i, '') : now.text;
        return text.slice(0, 100000);
      }
    }
    await pause(pollMs, signal);
  }
  throw new Error(`${service.name} से नया पूरा जवाब नहीं मिला। वेबसाइट पर जाँचें; संभव है लॉगिन, CAPTCHA या वेबसाइट के बदले हुए नियंत्रण की वजह से रुक गया हो।`);
}

module.exports = { SERVICES, assertOfficialHost, submitPrompt };
