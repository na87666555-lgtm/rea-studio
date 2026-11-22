'use strict';

// A single-user bridge to actual websites in an isolated Chromium context.
// The user operates the visible browser remotely. No model API substitution.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createMovieJobs } = require('./render/jobs.cjs');
const { chromium } = require('playwright');
const { SERVICES, assertOfficialHost, assertAccountReady, submitPrompt } = require('./providers.cjs');

const MAX_BODY = 160000;
const IDLE_MS = 20 * 60 * 1000;
const PAIR_CODE_MS = 10 * 60 * 1000;
const LEGACY_DEVICE_TOKEN_MS = 7 * 24 * 60 * 60 * 1000;
const VIEWPORT = { width: 412, height: 780 };
const HOSTS = [
  'chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com',
  'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com',
  'claude.ai', 'claude.com', 'anthropic.com', 'anthropic.io', 'anthropic-cdn.com',
  'cloudflare.com', 'hcaptcha.com', 'recaptcha.net', 'apple.com', 'microsoftonline.com', 'live.com',
];

function allowedDestination(raw) {
  try {
    const u = new URL(raw);
    if (!['https:', 'wss:'].includes(u.protocol) || u.username || u.password || (u.port && u.port !== '443')) return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return HOSTS.some(h => host === h || host.endsWith('.' + h));
  } catch { return false; }
}

function configuration(env = process.env) {
  if (env.REA_BRIDGE_TOKEN && env.REA_BRIDGE_TOKEN_FILE) throw new Error('Set either REA_BRIDGE_TOKEN or REA_BRIDGE_TOKEN_FILE, not both.');
  let token = env.REA_BRIDGE_TOKEN || '';
  if (env.REA_BRIDGE_TOKEN_FILE) {
    try { token = fs.readFileSync(env.REA_BRIDGE_TOKEN_FILE, 'utf8').trim(); }
    catch { throw new Error('Could not read the bridge token file.'); }
  }
  const origin = env.REA_APP_ORIGIN || 'https://na87666555-lgtm.github.io';
  if (token.length < 32) throw new Error('Set REA_BRIDGE_TOKEN to a unique random value of at least 32 characters.');
  let parsed;
  try { parsed = new URL(origin); } catch { throw new Error('REA_APP_ORIGIN must be an exact origin.'); }
  if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) throw new Error('REA_APP_ORIGIN must be an exact HTTPS origin, or local HTTP for development.');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
  return { token, origin, port, executablePath: env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined };
}

function hash(text) { return crypto.createHash('sha256').update(text).digest(); }
function tokenMatches(given, token) { return crypto.timingSafeEqual(hash(given), hash(token)); }

function createBridge({ token, origin, executablePath, launch = chromium.launch.bind(chromium), sendPrompt = submitPrompt, checkAccount = assertAccountReady, idleMs = IDLE_MS } = {}) {
  if (typeof token !== 'string' || token.length < 32 || !origin) throw new Error('Bridge configuration missing.');
  let browserPromise = null;
  let activeSession = null;
  let openingSession = null;
  let closing = false;
  let pairing = null;
  const expectedToken = token;
  const movies = createMovieJobs();

  function sign(payload) { return crypto.createHmac('sha256', expectedToken).update(payload).digest('base64url'); }
  function issueDeviceToken() {
    // A paired device remains authorized until the owner rotates the service
    // secret. This survives host restarts without retaining provider cookies.
    const payload = Buffer.from(JSON.stringify({ v: 2, scope: 'device', nonce: crypto.randomBytes(16).toString('base64url') })).toString('base64url');
    return `rea2.${payload}.${sign('rea2.' + payload)}`;
  }
  function validDeviceToken(given) {
    if (given.length > 1024) return false;
    const parts = given.split('.');
    if (parts.length !== 3 || !['rea1', 'rea2'].includes(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;
    // Bind v2's prefix into its signature so changing a legacy prefix cannot
    // turn an expired seven-day credential into a persistent one.
    const signed = parts[0] === 'rea2' ? 'rea2.' + parts[1] : parts[1];
    if (!tokenMatches(parts[2], sign(signed))) return false;
    try {
      const data = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
      if (parts[0] === 'rea2') return Object.keys(data).length === 3 && data.v === 2 && data.scope === 'device' && typeof data.nonce === 'string' && /^[A-Za-z0-9_-]{22}$/.test(data.nonce);
      return Number.isSafeInteger(data.exp) && data.exp > Date.now() && data.exp <= Date.now() + LEGACY_DEVICE_TOKEN_MS && typeof data.nonce === 'string';
    } catch { return false; }
  }

  function send(res, status, body) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': origin, vary: 'Origin' });
    res.end(JSON.stringify(body));
  }
  function error(status, message) { return Object.assign(new Error(message), { status, publicMessage: message }); }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw error(413, 'अनुरोध बहुत बड़ा है।');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw error(400, 'अनुरोध का प्रारूप सही नहीं है।'); }
  }
  async function getBrowser() {
    if (!browserPromise) {
      const pending = Promise.resolve().then(() => launch({ headless: true, ...(executablePath ? { executablePath } : {}) }));
      browserPromise = pending;
      pending.then(browser => {
        browser.once?.('disconnected', () => {
          if (browserPromise !== pending) return;
          browserPromise = null;
          closeSession(activeSession).catch(() => {});
        });
      }, () => { if (browserPromise === pending) browserPromise = null; });
    }
    return browserPromise;
  }
  async function closeSession(session) {
    if (!session || session.closed) return;
    session.closed = true;
    for (const controller of session.controllers) controller.abort();
    if (activeSession === session) activeSession = null;
    await session.context.close().catch(() => {});
  }
  async function openSession() {
    if (closing) throw error(503, 'ब्राउज़र सेवा बंद हो रही है।');
    if (activeSession && !activeSession.closed) { activeSession.touched = Date.now(); return activeSession; }
    if (!openingSession) openingSession = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false, permissions: [], serviceWorkers: 'block' });
      try {
        await context.route('**/*', route => allowedDestination(route.request().url()) ? route.continue() : route.abort('blockedbyclient'));
        if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', ws => allowedDestination(ws.url()) ? ws.connectToServer() : ws.close({ code: 1008, reason: 'Destination blocked' }));
        if (closing || (typeof browser.isConnected === 'function' && !browser.isConnected())) throw error(503, 'ब्राउज़र सत्र बंद हो गया। फिर से जोड़ें।');
        const session = { id: crypto.randomUUID(), context, pages: {}, activeService: null, resumeUrls: {}, pageQueue: Promise.resolve(), acknowledged: {}, controllers: new Set(), busy: false, busyService: null, touched: Date.now(), closed: false };
        activeSession = session;
        return session;
      } catch (e) { await context.close().catch(() => {}); throw e; }
    })().finally(() => { openingSession = null; });
    return openingSession;
  }
  function sessionFrom(req) {
    const id = req.headers['x-rea-session'];
    if (!activeSession || activeSession.closed || typeof id !== 'string' || id !== activeSession.id) throw error(401, 'ब्राउज़र सत्र नहीं मिला। फिर से जोड़ें।');
    activeSession.touched = Date.now();
    return activeSession;
  }
  function serviceOf(value) {
    if (typeof value !== 'string' || !Object.hasOwn(SERVICES, value)) throw error(400, 'वेबसाइट चुनें।');
    return SERVICES[value];
  }
  function watchPopup(session, id, page) {
    page.on('popup', popup => {
      if (session.closed || !session.pages[id]) { popup.close().catch(() => {}); return; }
      session.pages[id].active = popup;
      watchPopup(session, id, popup);
      popup.on('close', () => { if (!page.isClosed() && session.pages[id]?.active === popup) session.pages[id].active = page; });
    });
  }
  function conversationUrl(id, raw) {
    try {
      const url = new URL(raw); assertOfficialHost(url.toString(), SERVICES[id]);
      const prefix = { chatgpt: '/c/', gemini: '/app/', claude: '/chat/' }[id];
      if (!url.pathname.startsWith(prefix)) return '';
      url.search = ''; url.hash = ''; return url.toString();
    } catch { return ''; }
  }
  async function pageFor(session, id, openLogin = false) {
    const svc = serviceOf(id);
    const operation = async () => {
      if (session.closed) throw error(401, 'ब्राउज़र सत्र बंद हो गया।');
      if (session.activeService && session.activeService !== id) {
        const oldId = session.activeService; const old = session.pages[oldId];
        if (old) {
          const saved = !old.root.isClosed() && conversationUrl(oldId, old.root.url());
          if (saved) session.resumeUrls[oldId] = saved;
          if (old.active !== old.root && !old.active.isClosed()) await old.active.close().catch(() => {});
          if (!old.root.isClosed()) await old.root.close().catch(() => {});
          delete session.pages[oldId];
        }
      }
      session.activeService = id;
      if (!session.pages[id]) {
        const page = await session.context.newPage();
        session.pages[id] = { root: page, active: page };
        watchPopup(session, id, page);
        try { if (!openLogin) await page.goto(session.resumeUrls[id] || svc.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch { /* screenshot shows the page or network failure to the user */ }
      }
      const record = session.pages[id];
      if (record.active.isClosed()) record.active = record.root;
      if (openLogin) {
        delete session.acknowledged[id];
        try { await record.active.goto(svc.loginUrl, { waitUntil: 'commit', timeout: 20000 }); }
        catch { throw error(502, 'वेबसाइट का लॉगिन पेज खुल नहीं सका। फिर कोशिश करें।'); }
      }
      return record.active;
    };
    const next = session.pageQueue.then(operation, operation);
    session.pageQueue = next.catch(() => {});
    return next;
  }
  async function resetPage(session, id) {
    const record = session.pages[id];
    if (record) {
      if (record.active !== record.root && !record.active.isClosed()) await record.active.close().catch(() => {});
      if (!record.root.isClosed()) await record.root.close().catch(() => {});
      delete session.pages[id];
    }
    delete session.acknowledged[id];
    delete session.resumeUrls[id];
    return pageFor(session, id);
  }

  const server = http.createServer(async (req, res) => {
    // Do not log URL, bodies, screenshots, credentials, cookies or prompts.
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, { ok: true });
      if (req.headers.origin !== origin) throw error(403, 'इस ऐप से कनेक्शन की अनुमति नहीं है।');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type, X-Rea-Session', 'access-control-max-age': '600', vary: 'Origin' });
        return res.end();
      }
      if (req.method === 'POST' && !(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw error(415, 'JSON अनुरोध आवश्यक है।');
      if (url.pathname === '/v1/pair' && req.method === 'POST') {
        const data = await body(req);
        if (!pairing || pairing.expires <= Date.now() || pairing.failures >= 10 || typeof data.code !== 'string' || data.code.length > 128 || !crypto.timingSafeEqual(hash(data.code), pairing.codeHash)) {
          if (pairing) pairing.failures++;
          throw error(401, 'जोड़ने वाला लिंक गलत या समाप्त हो गया है।');
        }
        pairing = null; // A code grants access once, even for simultaneous requests.
        return send(res, 200, { token: issueDeviceToken() });
      }
      const authorization = req.headers.authorization || '';
      const given = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      const isAdmin = tokenMatches(given, expectedToken);
      if (url.pathname.startsWith('/v1/movies')) {
        const publicMovie = /^Movie [a-f0-9]{64}$/.test(authorization);
        if (!publicMovie && !isAdmin && !validDeviceToken(given)) throw error(401, 'वीडियो कनेक्शन उपलब्ध नहीं है।');
        const owner = hash(publicMovie ? authorization : given).toString('hex');
        if (req.method === 'POST' && url.pathname === '/v1/movies') {
          const { source } = await body(req);
          return send(res, 202, movies.start(owner, source, publicMovie));
        }
        const match = /^\/v1\/movies\/([a-f0-9-]{36})(?:\/(video|stop))?$/.exec(url.pathname);
        if (!match) throw error(404, 'रेंडर नहीं मिला।');
        const job = movies.get(owner, match[1]);
        if (req.method === 'POST' && match[2] === 'stop') { job.cancel(); return send(res, 200, job.status()); }
        if (req.method === 'GET' && !match[2]) return send(res, 200, job.status());
        if (req.method === 'GET' && match[2] === 'video') {
          const bytes = job.bytes();
          res.writeHead(200, { 'content-type':'video/mp4', 'content-length':bytes.length, 'cache-control':'no-store', 'access-control-allow-origin':origin, vary:'Origin' });
          return res.end(bytes);
        }
        throw error(405, 'रेंडर अनुरोध सही नहीं है।');
      }
      if (!isAdmin && !validDeviceToken(given)) throw error(401, 'ब्राउज़र सेवा का पासकोड गलत है।');
      if (url.pathname === '/v1/pair-code' && req.method === 'POST') {
        if (!isAdmin) throw error(403, 'नया जोड़ने वाला लिंक केवल सेवा का मालिक बना सकता है।');
        await body(req);
        const code = crypto.randomBytes(16).toString('base64url');
        pairing = { codeHash: hash(code), expires: Date.now() + PAIR_CODE_MS, failures: 0 };
        return send(res, 200, { code, expiresIn: PAIR_CODE_MS / 1000 });
      }
      if (url.pathname === '/v1/connect' && req.method === 'POST') {
        await body(req); const session = await openSession();
        const deviceToken = !isAdmin && given.startsWith('rea1.') ? issueDeviceToken() : undefined;
        return send(res, 200, { session: session.id, viewport: VIEWPORT, acknowledged: session.acknowledged, ...(deviceToken ? { deviceToken } : {}) });
      }
      const session = sessionFrom(req);
      if (url.pathname === '/v1/close' && req.method === 'POST') {
        await body(req); await closeSession(session); return send(res, 200, { ok: true });
      }
      if (url.pathname === '/v1/status' && req.method === 'GET') return send(res, 200, { acknowledged: session.acknowledged, busy: session.busy, activeService: session.activeService });
      if (url.pathname === '/v1/view' && req.method === 'GET') {
        const id = url.searchParams.get('service'); serviceOf(id);
        if (session.busy && session.busyService !== id) throw error(409, 'टीम दूसरी वेबसाइट पर काम कर रही है। पहले काम रोकें।');
        const page = await pageFor(session, id);
        const image = await page.screenshot({ type: 'jpeg', quality: 55, animations: 'disabled', timeout: 15000 });
        let host = ''; try { host = new URL(page.url()).hostname; } catch { /* loading */ }
        const title = await page.title().catch(() => '');
        const securityCheck = /just a moment|security verification|verify (?:you are|you.re) human|सुरक्षा जाँच/i.test(title);
        return send(res, 200, { image: image.toString('base64'), viewport: VIEWPORT, host, securityCheck, acknowledged: !!session.acknowledged[id], busy: session.busy });
      }
      if (url.pathname === '/v1/action' && req.method === 'POST') {
        const data = await body(req); serviceOf(data.service);
        if (session.busy) throw error(409, 'टीम काम कर रही है; पहले उसे रोकें।');
        if (data.action === 'login') {
          await pageFor(session, data.service, true);
          return send(res, 200, { ok: true });
        }
        const page = await pageFor(session, data.service);
        if (data.action === 'click') {
          const x = Number(data.x), y = Number(data.y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > VIEWPORT.width || y > VIEWPORT.height) throw error(400, 'क्लिक की जगह सही नहीं है।');
          await page.mouse.click(x, y);
        } else if (data.action === 'drag') {
          const x1 = Number(data.x1), y1 = Number(data.y1), x2 = Number(data.x2), y2 = Number(data.y2);
          if (![x1, y1, x2, y2].every(Number.isFinite) || [x1, x2].some(x => x < 0 || x > VIEWPORT.width) || [y1, y2].some(y => y < 0 || y > VIEWPORT.height)) throw error(400, 'हावभाव की जगह सही नहीं है।');
          await page.mouse.move(x1, y1); await page.mouse.down();
          try { await page.mouse.move(x2, y2, { steps: 12 }); } finally { await page.mouse.up(); }
        } else if (data.action === 'text') {
          if (typeof data.text !== 'string' || data.text.length > 4000) throw error(400, 'टेक्स्ट बहुत बड़ा है।');
          await page.keyboard.insertText(data.text);
        } else if (data.action === 'key') {
          if (!['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'Control+A'].includes(data.key)) throw error(400, 'यह बटन उपलब्ध नहीं है।');
          await page.keyboard.press(data.key);
        } else if (data.action === 'scroll') {
          const delta = Number(data.delta);
          if (!Number.isFinite(delta) || Math.abs(delta) > 1200) throw error(400, 'स्क्रॉल सही नहीं है।');
          await page.mouse.wheel(0, delta);
        } else if (data.action === 'reset') await resetPage(session, data.service);
        else throw error(400, 'यह ब्राउज़र क्रिया उपलब्ध नहीं है।');
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/v1/acknowledge' && req.method === 'POST') {
        const data = await body(req); const svc = serviceOf(data.service);
        if (session.busy) throw error(409, 'टीम काम कर रही है; पहले उसे रोकें।');
        const page = await pageFor(session, data.service);
        try { await checkAccount(page, svc); }
        catch (e) { delete session.acknowledged[data.service]; throw error(409, e.message); }
        session.acknowledged[data.service] = true;
        return send(res, 200, { ok: true, ready: true, notice: 'खाते का सत्र और चैट मिले। प्रीमियम प्लान और मॉडल की पुष्टि वेबसाइट पर अपने खाते में देखें।' });
      }
      if (url.pathname === '/v1/prompt' && req.method === 'POST') {
        const data = await body(req); const svc = serviceOf(data.service);
        if (!session.acknowledged[data.service]) throw error(409, `पहले ${svc.name} में लॉगिन पूरा करके पुष्टि करें।`);
        if (session.busy) throw error(409, 'ब्राउज़र पहले से काम कर रहा है।');
        if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 100000) throw error(400, 'संदेश खाली या बहुत बड़ा है।');
        session.busy = true; session.busyService = data.service;
        const controller = new AbortController(); session.controllers.add(controller);
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        try {
          const page = await pageFor(session, data.service);
          try { await checkAccount(page, svc); }
          catch (e) { delete session.acknowledged[data.service]; throw e; }
          const answer = await sendPrompt(page, svc, data.prompt, { signal: controller.signal });
          return send(res, 200, { answer, source: svc.name, host: new URL(page.url()).hostname });
        } catch (e) {
          if (controller.signal.aborted) return;
          if (/का चैट पेज|मिल[ाी]|लॉगिन|वेबसाइट/.test(e.message)) throw error(422, e.message);
          throw error(502, `${svc.name} पर काम पूरा नहीं हुआ। साइट खोलकर जाँचें और दोबारा प्रयास करें।`);
        } finally { session.busy = false; session.busyService = null; session.touched = Date.now(); session.controllers.delete(controller); res.removeListener('close', disconnected); }
      }
      throw error(404, 'यह पेज नहीं मिला।');
    } catch (e) { send(res, e.status || 500, { error: e.publicMessage || 'ब्राउज़र सेवा में त्रुटि आई।' }); }
  });
  server.on('close', () => movies.close());
  const timer = setInterval(() => {
    if (activeSession && !activeSession.busy && Date.now() - activeSession.touched > idleMs) closeSession(activeSession).catch(() => {});
  }, Math.min(idleMs, 60000));
  timer.unref();
  server.on('close', () => { closing = true; clearInterval(timer); closeSession(activeSession).catch(() => {}); browserPromise?.then(b => b.close()).catch(() => {}); });
  return server;
}

if (require.main === module) {
  try {
    const cfg = configuration();
    const server = createBridge(cfg);
    server.listen(cfg.port, '0.0.0.0', () => console.log(`Rea browser bridge listening on port ${cfg.port}`));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { createBridge, configuration, allowedDestination, tokenMatches };
