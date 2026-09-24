import { describe, it, expect, vi } from 'vitest';
import { createSemaphore, withTimeout, retryOnce } from '../../server/lib/semaphore.js';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('passes rejections through untagged (not flagged as timeouts)', async () => {
    const err = new Error('boom');
    await expect(withTimeout(Promise.reject(err), 1000)).rejects.toBe(err);
    expect(err.timeout).toBeUndefined();
  });

  it('rejects with a timeout-tagged error once the deadline passes', async () => {
    const pending = new Promise(() => {}); // never settles
    await expect(withTimeout(pending, 10, 'synthesis')).rejects.toMatchObject({
      timeout: true,
      message: 'synthesis timed out after 10ms',
    });
  });
});

describe('retryOnce', () => {
  it('returns the first success without a second call', async () => {
    const fn = vi.fn().mockResolvedValue('v');
    await expect(retryOnce(fn)).resolves.toBe('v');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once on failure by default, surfacing the second error', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'));
    await expect(retryOnce(fn)).rejects.toThrow('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('recovers when the retry succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue('ok');
    await expect(retryOnce(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when shouldRetry rejects the error (e.g. on-device timeout)', async () => {
    const err = Object.assign(new Error('synthesis timed out after 120000ms'), { timeout: true });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(retryOnce(fn, { shouldRetry: (e) => !e.timeout })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('still retries errors the predicate allows', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('noise glitch'));
    await expect(retryOnce(fn, { shouldRetry: (e) => !e.timeout })).rejects.toThrow('noise glitch');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('createSemaphore', () => {
  it('caps concurrency and drains the waiter queue to completion', async () => {
    const sem = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      });
    await Promise.all(Array.from({ length: 6 }, task));
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it('releases the slot even when the task throws', async () => {
    const sem = createSemaphore(1);
    await expect(sem.run(async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    // if the slot leaked, this second task would hang forever
    await expect(sem.run(async () => 'after')).resolves.toBe('after');
  });

  it('never runs a task whose signal is already aborted, and keeps the slot free', async () => {
    const sem = createSemaphore(1);
    const fn = vi.fn(async () => 'ran');
    const gone = AbortSignal.abort();
    await expect(sem.run(fn, { signal: gone })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fn).not.toHaveBeenCalled();
    await expect(sem.run(async () => 'next')).resolves.toBe('next');
  });

  it('drops a queued task whose signal aborts while it waits for a slot', async () => {
    const sem = createSemaphore(1);
    let release;
    const holder = sem.run(() => new Promise((r) => { release = r; }));
    const abandoned = new AbortController();
    const queuedFn = vi.fn(async () => 'should not run');
    const queued = sem.run(queuedFn, { signal: abandoned.signal });
    const after = sem.run(async () => 'after');
    abandoned.abort();
    // settles right away, before the holder frees its slot
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    release('held');
    await expect(holder).resolves.toBe('held');
    await expect(after).resolves.toBe('after');
    expect(queuedFn).not.toHaveBeenCalled();
  });

  it('lets a task that already started finish when its signal aborts later', async () => {
    const sem = createSemaphore(1);
    const ctl = new AbortController();
    const result = sem.run(async () => {
      ctl.abort();
      await new Promise((r) => setTimeout(r, 5));
      return 'finished';
    }, { signal: ctl.signal });
    await expect(result).resolves.toBe('finished');
    await expect(sem.run(async () => 'free')).resolves.toBe('free');
  });
});
