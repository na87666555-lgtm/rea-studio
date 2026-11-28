// Mobile routing regression. Research/provider HTTP responses are fixtures;
// the Three.js canvas and downloadable video use real Chromium rendering.
const { chromium } = require('playwright');
const { createServer } = require('node:http');
const { readFile, stat } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { openSavedChat } = require('./ui-helpers.cjs');
const assert = require('node:assert/strict');

async function main() {
  const root = path.resolve(__dirname, '..');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://local').pathname;
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + '/') || !(await stat(file)).isFile()) return res.writeHead(404).end();
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
  const errors = [];
  let researchCalls = 0;
  async function mobile(storage = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(storage => {
      if (window !== window.top) return;
      for (const [key, value] of Object.entries(storage)) if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    }, storage);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://*.wikipedia.org/w/api.php?*', route => {
      researchCalls++;
      return route.fulfill({ json: { query: { pages: { 1: { title: 'चंद्रमा', extract: 'चंद्रमा पृथ्वी का प्राकृतिक उपग्रह है। यह प्रकाशित स्रोत का परीक्षण अंश है।' } } } } });
    });
    return page;
  }
  async function send(page, text) {
    const count = await page.locator('.msg.assistant').count();
    await page.locator('#input').fill(text);
    await page.locator('#sendBtn').click();
    await page.waitForFunction(n => document.querySelectorAll('.msg.assistant').length > n && !document.querySelector('#sendBtn').classList.contains('stop'), count);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    return page.locator('.msg.assistant').last().innerText();
  }
  try {
    const page = await mobile();
    await page.goto(base);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.locator('#officialUrl').isVisible(), false);
    assert.equal(await page.locator('.welcome [data-action="new-team"]').count(), 0);
    const unavailable = await send(page, 'मेरे लिए एक कहानी लिखो');
    assert.match(unavailable, /Rea Studio · स्थिति/);
    assert.match(unavailable, /कोई तैयार मॉडल कनेक्शन उपलब्ध नहीं/);
    assert.equal(await page.locator('#input').inputValue(), '');
    assert.equal(researchCalls, 0, 'creative requests must not be sent to public search');
    assert.match(await send(page, 'तुम कौन सा मॉडल हो?'), /अभी किसी मॉडल का जवाब दर्ज नहीं/);
    assert.match(await send(page, 'चंद्रमा क्या है?'), /चंद्रमा पृथ्वी का प्राकृतिक उपग्रह/);
    const source = page.locator('.msg.assistant').last();
    assert.match(await source.locator('.meta').innerText(), /प्रकाशित स्रोत/);
    assert.equal(await source.locator('a').getAttribute('href'), 'https://hi.wikipedia.org/wiki/%E0%A4%9A%E0%A4%82%E0%A4%A6%E0%A5%8D%E0%A4%B0%E0%A4%AE%E0%A4%BE');
    assert.match(await send(page, 'Python चलाओ'), /पहले “Python चलाओ” लिखें/);
    await page.reload();
    assert.equal(await page.locator('.msg.user').count(), 4, 'requests and inline status persist');
    assert.equal(await page.locator('dialog[open]').count(), 0);

    await page.locator('#input').fill('लाल रंग का घूमता 3D घन बनाओ');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => !document.querySelector('#animationRecord').disabled);
    assert.equal(await page.locator('#animationShape').inputValue(), 'cube');
    assert.equal(await page.locator('#animationColor').inputValue(), '#f04b52');
    const canvas = page.locator('#animationPreview canvas');
    const before = await canvas.screenshot();
    await page.locator('#animationRecord').click();
    await page.waitForFunction(() => document.querySelector('#animationRecord').textContent.includes('रोकें'));
    assert.notDeepEqual(await canvas.screenshot(), before, 'the canvas must actually animate');
    await page.locator('#animationRecord').click();
    await page.locator('#animationDownload').waitFor({ state: 'visible' });
    const downloaded = page.waitForEvent('download');
    await page.locator('#animationDownload').click();
    const video = await downloaded;
    assert.match(video.suggestedFilename(), /^rea-animation\.(webm|mp4)$/);
    assert.ok((await stat(await video.path())).size > 100, 'download contains encoded video');
    await page.locator('#animationClose').click();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: '/tmp/rea-chat-first-mobile.png', fullPage: true });

    const incomplete = await mobile({
      'rea.v1.settings': { connections: [{ id: 'saved', defaultModel: 'test-model', baseUrl: 'https://provider.test', format: 'openai' }] },
      'rea.v1.chats': [{ id: 'incomplete', title: 'अधूरी टीम', team: { mode: 'api', members: [] }, messages: [] }],
    });
    await incomplete.goto(base);
    assert.equal(await incomplete.locator('#messages .team-welcome').count(), 0);
    await openSavedChat(incomplete, 'अधूरी टीम');
    assert.match(await send(incomplete, 'चंद्रमा क्या है?'), /प्रकाशित स्रोत/);
    assert.match(await send(incomplete, 'मेरे लिए कहानी लिखो'), /पूरा AI कनेक्शन उपलब्ध नहीं/);

    const paired = await mobile({ 'rea.officialBridge.device': { base: 'https://bridge.test', token: 'rea2.testdevice.testcredentials1234567890' } });
    const requests = [], prompts = [];
    let waitConnect = null, holdConnect = false;
    await paired.route('https://bridge.test/**', async route => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      if (url.pathname === '/v1/connect') {
        if (holdConnect) await new Promise(resolve => { waitConnect = resolve; });
        return route.fulfill({ json: { session: 'fixture-session', acknowledged: { chatgpt: true, gemini: true, claude: true } } }).catch(() => {});
      }
      assert.equal(url.pathname, '/v1/prompt');
      const request = route.request().postDataJSON(); prompts.push(request);
      const answer = request.prompt.includes('ONE useful final answer') ? 'तीनों का परीक्षण उत्तर' : `${request.service} का परीक्षण योगदान`;
      return route.fulfill({ json: { answer, source: request.service, host: { chatgpt: 'chatgpt.com', gemini: 'gemini.google.com', claude: 'claude.ai' }[request.service] } });
    });
    await paired.goto(base);
    assert.equal(requests.length, 0, 'opening chat must not wake the browser host');
    assert.match(await send(paired, 'मेरे लिए कहानी लिखो'), /तीनों का परीक्षण उत्तर/);
    assert.deepEqual(prompts.map(p => p.service), ['chatgpt', 'gemini', 'claude', 'claude']);
    assert.equal(await paired.locator('#officialUrl').isVisible(), false);
    await paired.reload();
    holdConnect = true;
    await paired.locator('#input').fill('एक और कहानी लिखो');
    await paired.locator('#sendBtn').click();
    await paired.waitForFunction(() => document.querySelector('.msg.assistant:last-child')?.textContent.includes('सेवा से जुड़ रहे'));
    await paired.locator('#sendBtn.stop').click();
    await paired.waitForFunction(() => !document.querySelector('#sendBtn').classList.contains('stop'));
    if (waitConnect) waitConnect();
    assert.match(await paired.locator('.msg.assistant').last().innerText(), /रोका गया/);
    assert.equal(prompts.length, 4, 'stopping reconnect must not send a prompt');
    assert.equal(await paired.locator('dialog[open]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: chat first, persistent inline notices, honest sources, incomplete team fallback, real 3D/video, saved website reconnect and Stop. Provider and research responses use fixtures.');
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
