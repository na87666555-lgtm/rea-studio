import test from 'node:test';
import assert from 'node:assert/strict';
import { filesOf, safePath, writeProject, projectTool, projectContext, previewDocument } from '../js/project.js';

test('shared project writes, reads and survives serialization independently per chat', () => {
  const a = {}, b = {};
  assert.equal(projectTool(a, 'project_write', { path: 'index.html', content: '<h1>Hello</h1>' }).ok, true);
  assert.equal(projectTool(a, 'project_read', { path: 'index.html' }).text, '<h1>Hello</h1>');
  assert.equal(projectTool(b, 'project_read', { path: 'index.html' }).ok, false);
  assert.deepEqual(filesOf(JSON.parse(JSON.stringify(a))), { 'index.html': '<h1>Hello</h1>' });
  assert.ok(projectContext(a).includes('Hello'));
});
test('workspace rejects unsafe paths and oversized content', () => {
  for (const path of ['../x', '/etc/passwd', '__proto__', 'a//b']) assert.throws(() => safePath(path));
  assert.throws(() => writeProject({}, 'file.txt', 'x'.repeat(100001)));
});
test('preview assembles saved local web files and defaults to network-blocking CSP', () => {
  const chat = {};
  writeProject(chat, 'index.html', '<link href="style.css"><h1>Test</h1><script src="script.js"></script>');
  writeProject(chat, 'style.css', 'h1{color:red}'); writeProject(chat, 'script.js', 'document.body.dataset.ready="yes"');
  const doc = previewDocument(chat);
  assert.match(doc, /connect-src 'none'/); assert.ok(doc.includes('h1{color:red}')); assert.ok(doc.includes('dataset.ready'));
});
