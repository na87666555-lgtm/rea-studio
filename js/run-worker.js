// Runs model-written JavaScript in a separate worker thread. Workers have no
// DOM and no localStorage, so code here cannot read the user's API keys.

function fmt(v) {
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v, null, 2);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

self.onmessage = async e => {
  const logs = [];
  const push = prefix => (...a) => logs.push(prefix + a.map(fmt).join(' '));
  const sandboxConsole = { log: push(''), info: push(''), warn: push('Warning: '), error: push('Error: '), debug: push('') };
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction('console', e.data.code);
    const result = await fn(sandboxConsole);
    self.postMessage({ ok: true, logs, result: result === undefined ? null : fmt(result) });
  } catch (err) {
    self.postMessage({ ok: false, logs, error: String((err && err.stack) || err) });
  }
};
