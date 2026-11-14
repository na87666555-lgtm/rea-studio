import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBridgeUrl, parseWebsiteEdits, buildWebsitePrompt } from '../js/official-bridge.js';

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
