// Per-connection concurrency limiter. Each API connection allows at most
// `limit` requests in flight; extra requests wait in a FIFO queue.

const pools = new Map();

function pool(key) {
  let p = pools.get(key);
  if (!p) {
    p = { active: 0, waiters: [] };
    pools.set(key, p);
  }
  return p;
}

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export function acquire(key, limit, signal) {
  const p = pool(key);
  const max = Math.max(1, Number(limit) || 1);
  if (signal?.aborted) return Promise.reject(abortError());
  if (p.active < max) {
    p.active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = {};
    const onAbort = () => {
      const i = p.waiters.indexOf(waiter);
      if (i >= 0) p.waiters.splice(i, 1);
      reject(abortError());
    };
    waiter.start = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.waiters.push(waiter);
  });
}

export function release(key, limit) {
  const p = pool(key);
  const max = Math.max(1, Number(limit) || 1);
  p.active = Math.max(0, p.active - 1);
  while (p.waiters.length && p.active < max) {
    p.active++;
    p.waiters.shift().start();
  }
}
