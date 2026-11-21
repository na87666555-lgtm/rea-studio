const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { submitPrompt, assertOfficialHost, SERVICES } = require('../providers.cjs');

test('official host verification rejects login redirects and impostors', () => {
  assert.doesNotThrow(() => assertOfficialHost('https://chatgpt.com/c/123', SERVICES.chatgpt));
  assert.throws(() => assertOfficialHost('https://chatgpt.com.evil.test/', SERVICES.chatgpt));
  assert.throws(() => assertOfficialHost('https://accounts.google.com/', SERVICES.gemini));
});

test('browser adapter captures only a new completed assistant answer, not old messages', async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.setContent(`<div class="assistant">पुराना</div><textarea id="input"></textarea><button id="send">Send</button>
      <script>document.querySelector('#send').onclick=()=>{ const n=document.createElement('div'); n.className='assistant'; n.textContent='नया '; document.body.append(n); setTimeout(()=>n.textContent+='जवाब',40); };</script>`);
    const svc = { name: 'Test', inputs: ['#input'], sends: ['#send'], answers: ['.assistant'], stops: [] };
    const result = await submitPrompt(page, svc, 'नमस्ते', { verifyHost: false, timeoutMs: 1500, settleMs: 100, pollMs: 20 });
    assert.equal(result, 'नया जवाब');
    await page.setContent('<div class="assistant">पुराना</div><textarea id="input"></textarea><button id="send">Send</button>');
    await assert.rejects(submitPrompt(page, svc, 'no response', { verifyHost: false, timeoutMs: 180, settleMs: 50, pollMs: 20 }), /नया पूरा जवाब नहीं मिला/);
  } finally { await browser.close(); }
});
