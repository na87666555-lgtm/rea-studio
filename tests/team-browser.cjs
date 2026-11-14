// End-to-end UI + real provider adapters; provider responses are mocked.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const server = createServer(async (req, res) => {
    try {
      const name = decodeURIComponent(new URL(req.url, 'http://local').pathname);
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + '/') || !(await stat(file)).isFile()) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const calls = []; let failGemini = false; let hold = false;
    await page.route('https://*.test/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } });
      const body = route.request().postDataJSON(); calls.push(body);
      if (hold) { await new Promise(r => setTimeout(r, 300)); }
      const anth = route.request().url().includes('anthropic.test');
      if (failGemini && body.model === 'gemini-test') return route.fulfill({ status: 429, json: { error: { message: 'Test limit' } } });
      const system = anth ? body.system : body.messages[0]?.content;
      const synth = system?.includes('ONE useful final answer');
      const reply = synth ? 'यह तीनों का साझा जवाब है: प्रोजेक्ट में सोलर ऊर्जा लगाएँ।' : `${body.model} का योगदान: सोलर ऊर्जा और लागत देखें।`;
      if (synth) return route.fulfill({ contentType: 'text/event-stream', body: anth
        ? `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
        : `data: ${JSON.stringify({ choices: [{ delta: { content: reply }, finish_reason: null }] })}\n\ndata: [DONE]\n\n` });
      return route.fulfill({ json: anth ? { content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }
        : { choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] } });
    });
    await page.goto(base);
    // A new user can add a connection without leaving the team setup.
    await page.locator('.welcome [data-action="new-team"]').click();
    await page.locator('[data-action="team-add-api"]').click();
    await page.locator('#cdPreset').selectOption('custom-openai');
    await page.locator('#cdName').fill('Test OpenAI');
    await page.locator('#cdBase').fill('https://openai.test/v1');
    await page.locator('#cdKey').fill('test-only');
    await page.locator('#cdModel').fill('gpt-test');
    await page.locator('#connForm [type="submit"]').click();
    assert.equal(await page.locator('#teamDialog').evaluate(d => d.open), true);
    assert.equal(await page.locator('#tdModel0').inputValue(), 'gpt-test');
    await page.locator('#teamDialog [data-action="close-dialog"]').click();
    const connections = ['gpt-test', 'gemini-test', 'claude-test'].map((model, i) => ({
      id: `api-${i}`, name: ['OpenAI', 'Google Gemini', 'Anthropic'][i], defaultModel: model, models: [model],
      apiKey: `test-only-${i}`, format: i === 2 ? 'anthropic' : 'openai', maxParallel: 3,
      baseUrl: `https://${['openai', 'gemini', 'anthropic'][i]}.test/v1`,
    }));
    await page.evaluate(connections => localStorage.setItem('rea.v1.settings', JSON.stringify({ connections, tools: { enabled: false } })), connections);
    await page.reload();
    await page.locator('.welcome [data-action="new-team"]').click();
    await page.locator('#tdTitle').fill('सोलर प्रोजेक्ट');
    await page.locator('#tdSystem').fill('बजट ₹50,000 है। आसान हिंदी में जवाब दें।');
    await page.locator('#teamForm [type="submit"]').click();
    await page.locator('#fileInput').setInputFiles({ name: 'requirements.txt', mimeType: 'text/plain', buffer: Buffer.from('Shared requirement: rooftop is 100 square metres.') });
    await page.waitForFunction(() => !document.querySelector('.att-chip .tool-spin'));
    await page.locator('#input').fill('मेरे घर के लिए सोलर प्रोजेक्ट की योजना बनाएँ।');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelector('.team-status')?.textContent.includes('साझा जवाब तैयार'));
    assert.equal(calls.length, 4);
    for (const body of calls) {
      assert.ok(JSON.stringify(body).includes('rooftop is 100 square metres'));
      assert.ok(JSON.stringify(body).includes('₹50,000'));
    }
    assert.equal(await page.locator('.msg.assistant > .content').count(), 1);
    assert.ok((await page.locator('.msg.assistant > .content').innerText()).includes('साझा जवाब'));
    await page.locator('.team-contributions > summary').click();
    assert.equal(await page.locator('.team-contribution').count(), 3);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/tmp/rea-team-mobile.png', fullPage: true });

    // Persistence and a follow-up on the same project.
    await page.reload();
    assert.equal(await page.locator('#topTitle').innerText(), 'सोलर प्रोजेक्ट');
    calls.length = 0; failGemini = true;
    await page.locator('#input').fill('इसकी लागत और समझाएँ।'); await page.locator('#sendBtn').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.team-status')].at(-1)?.textContent.includes('साझा जवाब तैयार'));
    assert.ok((await page.locator('.team-status').last().innerText()).includes('2/3'));
    assert.ok(calls.every(c => JSON.stringify(c).includes('मेरे घर के लिए सोलर')));
    assert.ok(calls.every(c => JSON.stringify(c).includes('यह तीनों का साझा जवाब')));
    failGemini = false; hold = true;
    await page.locator('#input').fill('अगला काम'); await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelector('#sendBtn').classList.contains('stop'));
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => !document.querySelector('#sendBtn').classList.contains('stop'));
    assert.ok((await page.locator('.team-status').last().innerText()).includes('रुक गया'));

    // Service worker includes the new module; same chat remains readable offline.
    await page.evaluate(() => navigator.serviceWorker.ready);
    assert.equal(await page.evaluate(async () => !!(await caches.match('./js/team.js'))), true);
    await context.setOffline(true); await page.reload();
    assert.equal(await page.locator('#topTitle').innerText(), 'सोलर प्रोजेक्ट');
    await context.setOffline(false); hold = false;
    await page.getByRole('button', { name: 'मेनू', exact: true }).click();
    await page.locator('[data-action="new-chat"]').click();
    await page.locator('#input').fill('एक मॉडल से सामान्य चैट'); await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelector('.msg.assistant .content')?.textContent.includes('gpt-test'));
    assert.equal(await page.locator('.team-progress').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: mobile team setup, all 3 adapters, shared files/history, synthesis streaming, partial failure, stop, persistence, offline shell, normal chat; no page errors.');
    await context.close();
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
