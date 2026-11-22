import test from 'node:test';
import assert from 'node:assert/strict';
import { OfficialBridge, normalizeBridgeUrl, parseWebsiteEdits, buildWebsitePrompt } from '../js/official-bridge.js';

test('a button acknowledgement cannot stand in for the service checking the account', async () => {
  const bridge = new OfficialBridge('https://bridge.example', 'test-credential-that-is-at-least-32-characters');
  bridge.request = async () => ({ ok: true });
  bridge.acknowledged.chatgpt = true;
  await assert.rejects(bridge.acknowledge('chatgpt'), /खाते की जाँच/);
  assert.equal(bridge.acknowledged.chatgpt, undefined);
  bridge.request = async () => ({ ok: true, ready: true });
  await bridge.acknowledge('chatgpt');
  assert.equal(bridge.acknowledged.chatgpt, true);
  bridge.request = async () => { throw new Error('Login expired'); };
  await assert.rejects(bridge.acknowledge('chatgpt'), /expired/);
  assert.equal(bridge.acknowledged.chatgpt, undefined);
});

test('bridge URL requires HTTPS except for local development, and rejects embedded credentials', () => {
  assert.equal(normalizeBridgeUrl('https://bridge.example/'), 'https://bridge.example');
  assert.equal(normalizeBridgeUrl('http://localhost:3000'), 'http://localhost:3000');
  assert.throws(() => normalizeBridgeUrl('http://public.example'));
  assert.throws(() => normalizeBridgeUrl('https://name:secret@example.com'));
  assert.throws(() => normalizeBridgeUrl('https://example.com/?token=secret'));
});

test('only a complete unambiguous JSON envelope can create project files', () => {
  const valid = { answer: 'ready', files: [{ path: 'index.html', content: '<h1>Hi</h1>' }] };
  assert.deepEqual(parseWebsiteEdits(JSON.stringify(valid)), valid);
  assert.deepEqual(parseWebsiteEdits('```json\n' + JSON.stringify(valid) + '\n```'), valid);
  assert.equal(parseWebsiteEdits('Here is code: ' + JSON.stringify(valid)), null);
  assert.equal(parseWebsiteEdits(JSON.stringify({ answer: 'x', files: [{ path: 'a', content: '1' }, { path: 'a', content: '2' }] })), null);
  assert.equal(parseWebsiteEdits(JSON.stringify({ answer: 'x', files: [{ path: 'a' }] })), null);
});

test('website prompt contains project instructions and history, rejecting oversize', () => {
  const prompt = buildWebsitePrompt('project instructions', [{ role: 'user', content: 'request' }]);
  assert.ok(prompt.includes('project instructions')); assert.ok(prompt.includes('request'));
  assert.throws(() => buildWebsitePrompt('', [{ content: 'x'.repeat(100001) }]), /बहुत लंबी/);
});
