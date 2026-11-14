// Runs model-written Python with Pyodide (Python compiled to WebAssembly),
// loaded once from the jsDelivr CDN and kept alive between runs. Workers have
// no DOM and no localStorage, so code here cannot read the user's API keys.

const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.8/full/';
let ready = null;
let out = [];

function load() {
  if (!ready) {
    ready = (async () => {
      // Pyodide 314+ only runs in module workers (this file is started with type: 'module').
      const { loadPyodide } = await import(PYODIDE_URL + 'pyodide.mjs');
      const py = await loadPyodide({ indexURL: PYODIDE_URL });
      py.setStdout({ batched: s => out.push(s) });
      py.setStderr({ batched: s => out.push(s) });
      return py;
    })();
    ready.catch(() => { ready = null; }); // allow a retry after a failed download
  }
  return ready;
}

self.onmessage = async e => {
  out = [];
  try {
    const py = await load();
    await py.loadPackagesFromImports(e.data.code, { messageCallback: () => {} });
    const result = await py.runPythonAsync(e.data.code);
    let text = null;
    if (result !== undefined && result !== null) {
      text = String(result);
      if (result && typeof result.destroy === 'function') result.destroy();
    }
    self.postMessage({ ok: true, logs: out, result: text });
  } catch (err) {
    self.postMessage({ ok: false, logs: out, error: String((err && err.message) || err) });
  }
};
