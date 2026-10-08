import { describe, it, expect, vi, beforeEach } from 'vitest';

const tts = vi.hoisted(() => vi.fn());
vi.mock('../../public/js/api.js', () => ({ api: { tts } }));

import { createQueue } from '../../public/js/queue.js';

const chunks = Array.from({ length: 6 }, (_, i) => ({ text: `Chunk ${i}.` }));
const audioBase64 = Buffer.from('MP3').toString('base64');

describe('createQueue', () => {
  beforeEach(() => {
    tts.mockReset();
  });

  it('passes every synthesis request an abort signal', () => {
    tts.mockImplementation(() => new Promise(() => {}));
    const queue = createQueue({ chunks, provider: 'kokoro', voice: 'af_heart' });
    queue.ensureWindow(0);
    expect(tts).toHaveBeenCalledTimes(2); // at most 2 in flight
    for (const [, , , options] of tts.mock.calls) {
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('aborts in-flight requests on dispose, so a voice switch frees the engine', () => {
    tts.mockImplementation(() => new Promise(() => {}));
    const queue = createQueue({ chunks, provider: 'supertonic', voice: 'M1' });
    queue.ensureWindow(0);
    const signals = tts.mock.calls.map(([, , , options]) => options.signal);
    expect(signals.some((s) => s.aborted)).toBe(false);
    queue.dispose();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it('reports no error for a request it aborted itself', async () => {
    const onError = vi.fn();
    tts.mockImplementation(
      (provider, voice, text, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })),
          );
        }),
    );
    const queue = createQueue({ chunks, provider: 'kokoro', voice: 'af_heart', onError });
    queue.ensureWindow(0);
    queue.dispose();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).not.toHaveBeenCalled();
    expect(tts).toHaveBeenCalledTimes(2); // the freed slots fetch nothing more
  });

  it('still hands ready audio to the player', async () => {
    const onReady = vi.fn();
    tts.mockResolvedValue({ audioBase64, words: [] });
    const queue = createQueue({ chunks, provider: 'edge', voice: 'v', onReady });
    queue.ensureWindow(0);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith(0, expect.objectContaining({ status: 'ready' })));
    queue.dispose();
  });
});
