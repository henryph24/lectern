export function createSemaphore(max) {
  let active = 0;
  const waiters = [];

  const acquire = () =>
    new Promise((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });

  const release = () => {
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  };

  return {
    async run(fn) {
      await acquire();
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
