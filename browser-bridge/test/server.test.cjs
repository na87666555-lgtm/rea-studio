const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, configuration, allowedDestination, tokenMatches } = require('../server.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const token = 'this-is-a-test-token-with-40-characters-long';
const origin = 'https://na87666555-lgtm.github.io';

test('configuration rejects weak secrets and nonlocal cleartext origins', () => {
  assert.throws(() => configuration({ REA_BRIDGE_TOKEN: 'short' }), /32/);
  assert.throws(() => configuration({ REA_BRIDGE_TOKEN: token, REA_APP_ORIGIN: 'http://example.com' }), /HTTPS/);
  assert.equal(configuration({ REA_BRIDGE_TOKEN: token, REA_APP_ORIGIN: origin }).origin, origin);
  assert.equal(tokenMatches(token, token), true); assert.equal(tokenMatches('wrong', token), false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-secret-test-'));
  try {
    const file = path.join(dir, 'token'); fs.writeFileSync(file, token + '\n', { mode: 0o600 });
    assert.equal(configuration({ REA_BRIDGE_TOKEN_FILE: file }).token, token);
    assert.throws(() => configuration({ REA_BRIDGE_TOKEN: token, REA_BRIDGE_TOKEN_FILE: file }), /either/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('browser network is restricted to public provider and login hostnames', () => {
  for (const url of ['https://chatgpt.com/', 'https://accounts.google.com/', 'https://claude.ai/', 'wss://chatgpt.com/ws']) assert.equal(allowedDestination(url), true, url);
  for (const url of ['http://chatgpt.com/', 'https://chatgpt.com.evil.test/', 'http://127.0.0.1/', 'https://169.254.169.254/', 'file:///etc/passwd', 'https://u:p@chatgpt.com/', 'https://chatgpt.com:1234/', 'https://evil.test/']) assert.equal(allowedDestination(url), false, url);
});

test('bridge requires the configured origin and secret; session opening is serialized', async () => {
  let contexts = 0, closed = 0;
  const fakeContext = () => ({ route: async () => {}, routeWebSocket: async () => {}, close: async () => { closed++; } });
  const launch = async () => ({ newContext: async () => { contexts++; await new Promise(r => setTimeout(r, 15)); return fakeContext(); }, close: async () => {} });
  const server = createBridge({ token, origin, launch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/v1/connect', { method: 'POST', headers: { ...headers, origin: 'https://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await fetch(base + '/v1/connect', { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: '{}' })).status, 401);
    const pair = await Promise.all([1, 2].map(() => fetch(base + '/v1/connect', { method: 'POST', headers, body: '{}' }).then(r => r.json())));
    assert.equal(contexts, 1); assert.equal(pair[0].session, pair[1].session);
    assert.equal((await fetch(base + '/v1/status', { headers: { ...headers, 'x-rea-session': 'wrong' } })).status, 401);
    const authenticated = { ...headers, 'x-rea-session': pair[0].session };
    assert.equal((await fetch(base + '/v1/prompt', { method: 'POST', headers: authenticated, body: JSON.stringify({ service: 'chatgpt', prompt: 'hello' }) })).status, 409);
    assert.equal((await fetch(base + '/v1/close', { method: 'POST', headers: authenticated, body: '{}' })).status, 200);
    assert.equal(closed, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('pairing is private, short-lived, one-use, and cannot create new pairing codes', async () => {
  const launch = async () => ({ newContext: async () => ({ route: async () => {}, routeWebSocket: async () => {}, close: async () => {} }), close: async () => {} });
  const server = createBridge({ token, origin, launch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = (route, data, h = headers) => fetch(base + route, { method: 'POST', headers: h, body: JSON.stringify(data) });
  try {
    assert.equal((await post('/v1/pair-code', {}, { ...headers, authorization: 'Bearer wrong' })).status, 401);
    const issued = await (await post('/v1/pair-code', {})).json();
    assert.equal(issued.expiresIn, 600);
    assert.equal((await post('/v1/pair', { code: issued.code }, { ...headers, origin: 'https://evil.test' })).status, 403);
    assert.equal((await post('/v1/pair', { code: 'wrong' }, { origin, 'content-type': 'application/json' })).status, 401);
    const pairHeaders = { origin, 'content-type': 'application/json' };
    const paired = await (await post('/v1/pair', { code: issued.code }, pairHeaders)).json();
    assert.ok(paired.token.startsWith('rea2.')); assert.notEqual(paired.token, token);
    assert.equal((await post('/v1/pair', { code: issued.code }, pairHeaders)).status, 401);
    const deviceHeaders = { ...headers, authorization: `Bearer ${paired.token}` };
    assert.equal((await post('/v1/pair-code', {}, deviceHeaders)).status, 403);
    assert.equal((await post('/v1/connect', {}, deviceHeaders)).status, 200);
    assert.equal((await post('/v1/connect', {}, { ...headers, authorization: `Bearer ${paired.token}x` })).status, 401);
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000, nonce: 'expired' })).toString('base64url');
    const signature = crypto.createHmac('sha256', token).update(payload).digest('base64url');
    assert.equal((await post('/v1/connect', {}, { ...headers, authorization: `Bearer rea1.${payload}.${signature}` })).status, 401);
    const next = await (await post('/v1/pair-code', {})).json();
    for (let i = 0; i < 10; i++) assert.equal((await post('/v1/pair', { code: 'wrong' }, pairHeaders)).status, 401);
    assert.equal((await post('/v1/pair', { code: next.code }, pairHeaders)).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('persistent device tokens survive restart, keep their scope, and revoke on administrator secret rotation', async () => {
  const launch = async () => ({ newContext: async () => ({ route: async () => {}, routeWebSocket: async () => {}, close: async () => {} }), close: async () => {} });
  const start = async secret => {
    const server = createBridge({ token: secret, origin, launch });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { server, post: (route, data, credential = secret) => fetch(base + route, { method: 'POST', headers: { origin, authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(data) }) };
  };
  let instance = await start(token);
  try {
    const { code } = await (await instance.post('/v1/pair-code', {})).json();
    const { token: device } = await (await instance.post('/v1/pair', { code }, '')).json();
    const parts = device.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.deepEqual(Object.keys(payload).sort(), ['nonce', 'scope', 'v']);
    assert.equal(payload.scope, 'device'); assert.equal(payload.v, 2);
    const first = await (await instance.post('/v1/connect', {}, device)).json();
    assert.ok(first.session); assert.equal(first.deviceToken, undefined);
    const swappedPrefix = device.replace(/^rea2/, 'rea1');
    assert.equal((await instance.post('/v1/connect', {}, swappedPrefix)).status, 401);
    const modifiedPayload = Buffer.from(JSON.stringify({ ...payload, scope: 'admin' })).toString('base64url');
    assert.equal((await instance.post('/v1/connect', {}, `rea2.${modifiedPayload}.${parts[2]}`)).status, 401);
    // Even a correctly signed v2 token must have the exact device schema.
    for (const data of [{ ...payload, scope: 'admin' }, { ...payload, v: 1 }, { ...payload, nonce: 'short' }, { ...payload, exp: Date.now() + 1e9 }]) {
      const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
      const signature = crypto.createHmac('sha256', token).update('rea2.' + encoded).digest('base64url');
      assert.equal((await instance.post('/v1/connect', {}, `rea2.${encoded}.${signature}`)).status, 401);
    }
    assert.equal((await instance.post('/v1/pair-code', {}, device)).status, 403);
    await new Promise(resolve => instance.server.close(resolve));
    instance = await start(token);
    const second = await (await instance.post('/v1/connect', {}, device)).json();
    assert.ok(second.session); assert.notEqual(second.session, first.session);
    assert.deepEqual(second.acknowledged, {});
    await new Promise(resolve => instance.server.close(resolve));
    instance = await start(token + '-rotated');
    assert.equal((await instance.post('/v1/connect', {}, device)).status, 401);
  } finally { await new Promise(resolve => instance.server.close(resolve)); }
});

test('legacy device tokens upgrade only after connection and retain their original expiry checks', async () => {
  let failLaunch = true;
  const launch = async () => {
    if (failLaunch) throw new Error('launch unavailable');
    return { newContext: async () => ({ route: async () => {}, routeWebSocket: async () => {}, close: async () => {} }), close: async () => {} };
  };
  const legacy = exp => {
    const payload = Buffer.from(JSON.stringify({ exp, nonce: crypto.randomBytes(16).toString('base64url') })).toString('base64url');
    return `rea1.${payload}.${crypto.createHmac('sha256', token).update(payload).digest('base64url')}`;
  };
  const server = createBridge({ token, origin, launch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const connect = credential => fetch(base + '/v1/connect', { method: 'POST', headers: { origin, authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: '{}' });
  try {
    const valid = legacy(Date.now() + 3600000);
    const expired = legacy(Date.now() - 1000);
    const failed = await connect(valid); assert.equal(failed.status, 500); assert.equal((await failed.json()).deviceToken, undefined);
    failLaunch = false;
    assert.equal((await connect(expired)).status, 401);
    assert.equal((await connect(expired.replace(/^rea1/, 'rea2'))).status, 401);
    assert.equal((await connect(valid.replace(/^rea1/, 'rea2'))).status, 401);
    assert.equal((await connect(legacy(Date.now() + 8 * 86400000))).status, 401);
    const upgraded = await connect(valid); assert.equal(upgraded.status, 200);
    const result = await upgraded.json(); assert.ok(result.deviceToken.startsWith('rea2.'));
    assert.equal((await connect(result.deviceToken)).status, 200);
    const admin = await (await connect(token)).json(); assert.equal(admin.deviceToken, undefined);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('disconnected Chromium is relaunched and the old browser session cannot be reused', async () => {
  let launches = 0, contextCloses = 0;
  const browsers = [];
  const launch = async () => {
    launches++;
    const browser = new EventEmitter();
    let connected = true;
    browser.isConnected = () => connected;
    browser.disconnect = () => { connected = false; browser.emit('disconnected'); };
    browser.close = async () => browser.disconnect();
    browser.newContext = async () => ({ route: async () => {}, routeWebSocket: async () => {}, close: async () => { contextCloses++; } });
    browsers.push(browser); return browser;
  };
  const server = createBridge({ token, origin, launch });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const connect = () => fetch(base + '/v1/connect', { method: 'POST', headers, body: '{}' }).then(r => r.json());
  try {
    const first = await connect(); browsers[0].disconnect();
    assert.equal((await fetch(base + '/v1/status', { headers: { ...headers, 'x-rea-session': first.session } })).status, 401);
    const [second, concurrent] = await Promise.all([connect(), connect()]);
    assert.equal(launches, 2); assert.equal(contextCloses, 1);
    assert.notEqual(first.session, second.session); assert.equal(second.session, concurrent.session);
    assert.deepEqual(second.acknowledged, {});
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('website switching retains one page and an active reply cannot be interrupted by other-site controls', async () => {
  let opened = 0, closedPages = 0, release;
  let started; const startedPromise = new Promise(r => { started = r; });
  const fakePage = () => {
    let current = '', closed = false;
    return { on: () => {}, goto: async url => { current = url; }, url: () => current,
      isClosed: () => closed, close: async () => { if (!closed) { closed = true; closedPages++; } },
      screenshot: async () => Buffer.from('image'), mouse: { click: async () => {}, wheel: async () => {} },
      keyboard: { insertText: async () => {}, press: async () => {} } };
  };
  const context = { route: async () => {}, routeWebSocket: async () => {}, newPage: async () => { opened++; return fakePage(); }, close: async () => {} };
  const launch = async () => ({ newContext: async () => context, close: async () => {} });
  const sendPrompt = async () => { started(); await new Promise(r => { release = r; }); return 'actual-site-reply'; };
  const server = createBridge({ token, origin, launch, sendPrompt });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = (route, data) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(data) });
  try {
    const connected = await (await post('/v1/connect', {})).json(); headers['x-rea-session'] = connected.session;
    assert.equal((await fetch(base + '/v1/view?service=chatgpt', { headers })).status, 200);
    assert.equal((await post('/v1/acknowledge', { service: 'chatgpt' })).status, 200);
    const reply = post('/v1/prompt', { service: 'chatgpt', prompt: 'hello' });
    await startedPromise;
    assert.equal((await fetch(base + '/v1/view?service=gemini', { headers })).status, 409);
    assert.equal((await post('/v1/action', { service: 'chatgpt', action: 'text', text: 'do not interfere' })).status, 409);
    release(); assert.equal((await (await reply).json()).answer, 'actual-site-reply');
    assert.equal((await fetch(base + '/v1/view?service=gemini', { headers })).status, 200);
    assert.equal(opened, 2); assert.equal(closedPages, 1);
    assert.equal((await post('/v1/action', { service: 'gemini', action: 'click', x: -1, y: 10 })).status, 400);
    await post('/v1/close', {});
  } finally { await new Promise(resolve => server.close(resolve)); }
});
