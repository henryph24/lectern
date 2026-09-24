// The error a queued task settles with when its signal aborts before it gets
// a slot. Callers tell it apart by name (the Web platform's convention).
function abandonedError() {
  return Object.assign(new Error('Abandoned before a slot was free'), { name: 'AbortError' });
}

export function createSemaphore(max) {
  let active = 0;
  const waiters = [];

  const acquire = (signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abandonedError());
        return;
      }
      if (active < max) {
        active++;
        resolve();
        return;
      }
      const waiter = { resolve, signal, onAbort: null };
      if (signal) {
        // leave the queue at once: an abandoned task must neither run nor
        // hold a place ahead of live ones
        waiter.onAbort = () => {
          const at = waiters.indexOf(waiter);
          if (at !== -1) waiters.splice(at, 1);
          reject(abandonedError());
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      waiters.push(waiter);
    });

  const release = () => {
    const next = waiters.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.onAbort);
      next.resolve();
    } else {
      active--;
    }
  };

  return {
    // `signal` covers the wait for a slot only: once `fn` starts it runs to
    // completion, whatever the signal does afterwards.
    async run(fn, { signal } = {}) {
      await acquire(signal);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error(`${label} timed out after ${ms}ms`), { timeout: true })),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Retry `fn` at most once. By default any failure is retried (transient network
// blips). Pass `shouldRetry` to opt out of retrying specific errors — e.g. an
// on-device synthesis timeout: the first attempt is uncancelable and keeps
// burning CPU, so a second concurrent attempt only compounds the load.
export async function retryOnce(fn, { shouldRetry = () => true } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (!shouldRetry(err)) throw err;
    return await fn();
  }
}
