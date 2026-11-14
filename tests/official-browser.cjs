// Mobile UI integration with a simulated bridge; it never logs into providers.
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
      if (!file.startsWith(root + '/') || !(await stat(file)).isFile()) return res.writeHead(404).end();
      res.setHeader('Content-Type', types[path.extname(file)] || 'text/plain'); res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const failures = []; page.on('pageerror', e => failures.push(e.message));
    let screenshot = ''; const acknowledged = {}; const prompts = []; const actions = [];
    const hosts = { chatgpt: 'chatgpt.com', gemini: 'gemini.google.com', claude: 'claude.ai' };
    const key = 'test-only-browser-service-key-1234567890';
    const existingApiKey = 'test-existing-coarena-key-do-not-send';
    await page.route('https://bridge.test/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': base, 'access-control-allow-headers': 'authorization, content-type, x-rea-session', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
      assert.equal(req.headers().authorization, 'Bearer ' + key);
      const data = req.method() === 'POST' ? req.postDataJSON() : {};
      let json;
      if (url.pathname === '/v1/connect') json = { session: 'test-session', acknowledged, viewport: { width: 412, height: 780 } };
      else if (url.pathname === '/v1/status') json = { acknowledged, busy: false };
      else if (url.pathname === '/v1/view') { const site = url.searchParams.get('service'); json = { image: screenshot, host: hosts[site], acknowledged: !!acknowledged[site], busy: false }; }
      else if (url.pathname === '/v1/acknowledge') { acknowledged[data.service] = true; json = { ok: true, notice: 'आपकी पुष्टि दर्ज हुई।' }; }
      else if (url.pathname === '/v1/action') { actions.push(data); json = { ok: true }; }
      else if (url.pathname === '/v1/close') json = { ok: true };
      else if (url.pathname === '/v1/prompt') {
        assert.equal(acknowledged[data.service], true);
        assert.ok(!data.prompt.includes(key)); assert.ok(!data.prompt.includes(existingApiKey)); prompts.push(data);
        const final = data.prompt.includes('ONE useful final answer');
        let answer;
        if (final) { assert.ok(data.prompt.includes('अंतिम कोड')); answer = 'एक साझा अंतिम जवाब'; }
        else if (data.service === 'chatgpt') answer = 'पहले योजना बनाओ';
        else if (data.service === 'gemini') { assert.ok(data.prompt.includes('पहले योजना बनाओ')); answer = JSON.stringify({ answer: 'फ़ाइल तैयार', files: [{ path: 'index.html', content: '<h1>अंतिम कोड</h1>' }] }); }
        else { assert.ok(data.prompt.includes('फ़ाइल तैयार')); assert.ok(data.prompt.includes('अंतिम कोड')); answer = JSON.stringify({ answer: 'कोड की जाँच पूरी', files: [] }); }
        json = { answer, host: hosts[data.service], source: data.service };
      } else return route.fulfill({ status: 404, json: { error: 'missing route' } });
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': base, 'content-type': 'application/json' }, body: JSON.stringify(json) });
    });
    await page.goto(base);
    await page.evaluate(existingApiKey => localStorage.setItem('rea.v1.settings', JSON.stringify({ connections: [{ id: 'existing', name: 'Coarena', baseUrl: 'https://coarena.ai/api/v1', format: 'openai', apiKey: existingApiKey, defaultModel: 'test-existing' }], defaultConnectionId: 'existing' })), existingApiKey);
    await page.reload();
    screenshot = (await page.screenshot({ type: 'jpeg' })).toString('base64');
    await page.locator('.welcome [data-action="new-team"]').click();
    await page.locator('#tdMode').selectOption('website');
    assert.equal(await page.locator('#teamApiFields').isHidden(), true);
    await page.locator('#tdTitle').fill('वेबसाइट परियोजना');
    await page.locator('#teamWebsiteHint [data-action="official-browser"]').click();
    await page.locator('#officialUrl').fill('https://bridge.test');
    await page.locator('#officialToken').fill(key);
    await page.locator('[data-action="official-connect"]').click();
    await page.waitForFunction(() => !document.querySelector('#officialControls').hidden);
    for (const site of ['chatgpt', 'gemini', 'claude']) {
      await page.locator(`[data-action="official-site"][data-site="${site}"]`).click();
      await page.waitForFunction(host => document.querySelector('#officialSite').textContent.includes(host), hosts[site]);
      await page.locator('[data-action="official-ack"]').click();
      await page.waitForFunction(() => document.querySelector('#officialSite').textContent.includes('पुष्टि दर्ज'));
    }
    await page.locator('#officialText').fill('test input');
    await page.locator('[data-action="official-type"]').click();
    await page.waitForFunction(() => !document.querySelector('#officialText').value);
    assert.ok(actions.some(x => x.action === 'text' && x.text === 'test input'));
    await page.locator('#officialDialog [data-action="close-dialog"]').click();
    await page.locator('#teamForm [type="submit"]').click();
    await page.locator('#input').fill('एक छोटा वेब पेज बनाओ');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelector('.team-status')?.textContent.includes('साझा जवाब तैयार'));
    assert.deepEqual(prompts.map(p => p.service), ['chatgpt', 'gemini', 'claude', 'claude']);
    assert.ok((await page.locator('.msg.assistant > .content').innerText()).includes('एक साझा अंतिम जवाब'));
    await page.waitForFunction(() => !document.querySelector('#sendBtn').classList.contains('stop'));
    await page.locator('#projectBtn').click();
    assert.equal(await page.locator('#projectPath').inputValue(), 'index.html');
    assert.ok((await page.locator('#projectContent').inputValue()).includes('अंतिम कोड'));
    assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(key));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rea.v1.settings')).connections[0].apiKey), existingApiKey);
    assert.deepEqual(failures, []);
    console.log('PASS: simulated official browser login UI, role handoff, shared file save and single result; no API calls or real account login.');
    await context.close();
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
