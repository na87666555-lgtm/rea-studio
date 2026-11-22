import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDirectPython, runDirectPython } from '../js/direct-python.js';

const script = 'for i in [1, 2]:\n    print(i)';
const fence = '```python\n' + script + '\n```';

test('extracts only a complete Python block after a standalone command', () => {
  for (const command of ['Python चलाओ', 'कृपया यह पायथन कोड चलाइए।', 'Run my Python script:', '/python']) {
    assert.deepEqual(parseDirectPython(command + '\n\n' + fence), { code: script });
  }
  assert.deepEqual(parseDirectPython('Execute Python\r\n~~~py\r\nprint(3)\r\n~~~~'), { code: 'print(3)' });
  assert.deepEqual(parseDirectPython('Run python\n````python\ns = """\n```\n"""\n````'), { code: 's = """\n```\n"""' });
});

test('leaves discussion, research quotations and unprompted snippets in normal chat', () => {
  for (const text of [fence, 'Explain this:\n' + fence, 'Search for examples\nPython चलाओ\n' + fence,
    '> Run Python\n' + fence, 'Can I run Python?\n' + fence, 'Run this Python code later\n' + fence,
    'Python चलाना कैसे सीखें?', 'This article says “Run Python”.\n' + fence]) {
    assert.equal(parseDirectPython(text), null);
  }
});

test('rejects missing code, mismatched delimiters, multiple blocks or trailing instructions', () => {
  for (const body of ['', '```python\nprint(3)', '```\n\n```', '```js\nalert(1)\n```',
    '```python\nx = 1\n~~~', fence + '\n' + fence, fence + '\nnow run some more']) {
    assert.ok(parseDirectPython('Python चलाओ\n' + body).error);
  }
});

test('direct execution obeys the global and Python tool switches without starting a worker', async () => {
  for (const tools of [{ enabled: false }, { python: false }]) {
    const result = await runDirectPython({ code: script }, { tools });
    assert.equal(result.ok, false);
    assert.match(result.text, /सेटिंग्स/);
  }
  assert.deepEqual(await runDirectPython({ error: 'missing script' }, {}), { ok: false, text: 'missing script' });
});

test('dispatches to the existing Python worker, passes uploaded files, and allows Stop', async t => {
  const seen = [];
  let terminated = false;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  class MockWorker {
    constructor(url, options) {
      assert.match(url.pathname, /py-worker\.js$/);
      assert.equal(options.type, 'module');
    }
    postMessage(packet) {
      seen.push(packet);
      if (seen.length === 1) {
        queueMicrotask(() => this.onmessage({ data: { ok: true, logs: ['21'], result: null } }));
      } else {
        signalStarted();
      }
    }
    terminate() { terminated = true; }
  }
  const previous = globalThis.Worker;
  globalThis.Worker = MockWorker;
  t.after(() => { if (previous === undefined) delete globalThis.Worker; else globalThis.Worker = previous; });
  const context = { files: async () => [{ id: '1', name: 'data.txt', blob: new Blob(['21']) }] };
  assert.deepEqual(await runDirectPython({ code: script }, {}, undefined, context), { ok: true, text: '21' });
  assert.equal(seen[0].code, script);
  assert.equal(new TextDecoder().decode(seen[0].files[0].buf), '21');
  const controller = new AbortController();
  const pending = runDirectPython({ code: 'while True: pass' }, {}, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminated, true);
});
