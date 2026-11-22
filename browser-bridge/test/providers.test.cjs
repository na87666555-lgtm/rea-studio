const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { submitPrompt, assertOfficialHost, assertAccountReady, SERVICES } = require('../providers.cjs');

test('account check rejects guests, missing chat and logout controls; a session cookie alone is insufficient', async () => {
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route('**/*', r => r.fulfill({ contentType: 'text/html', body: '<textarea id="prompt-textarea"></textarea>' }));
  try {
    await page.goto(SERVICES.chatgpt.url);
    await assert.rejects(assertAccountReady(page, SERVICES.chatgpt), /खाते का लॉगिन नहीं मिला/);
    await context.addCookies([{ name: '__Secure-next-auth.session-token', value: 'fixture-only', url: SERVICES.chatgpt.url, secure: true }]);
    await assert.doesNotReject(assertAccountReady(page, SERVICES.chatgpt));
    await page.setContent('<h1>Security check</h1>');
    await assert.rejects(assertAccountReady(page, SERVICES.chatgpt), /चैट अभी तैयार नहीं/);
    await page.setContent('<textarea id="prompt-textarea"></textarea><button data-testid="login-button">Log in</button>');
    await assert.rejects(assertAccountReady(page, SERVICES.chatgpt), /खाते का लॉगिन नहीं मिला/);
    await context.clearCookies();
    await page.setContent('<textarea id="prompt-textarea"></textarea>');
    await assert.rejects(assertAccountReady(page, SERVICES.chatgpt), /खाते का लॉगिन नहीं मिला/);
  } finally { await browser.close(); }
});

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
