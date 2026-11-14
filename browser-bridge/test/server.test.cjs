const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, configuration, allowedDestination, tokenMatches } = require('../server.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
