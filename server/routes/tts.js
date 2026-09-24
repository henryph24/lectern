import { Router } from 'express';
import { getProvider } from '../providers/index.js';
import { cacheKey } from '../lib/cache.js';
import { createSemaphore, withTimeout, retryOnce } from '../lib/semaphore.js';

const MAX_TTS_CHARS = 2000;
// Fallbacks when a provider doesn't declare its own; the real values live in
// providers/index.js because they're provider-specific (network vs on-device).
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_CONCURRENCY = 2;

export function ttsRouter({ cache }) {
  const router = Router();
  // One queue per provider, so a slow or stuck provider (on-device inference
  // runs for seconds) never holds the slots another provider needs.
  const queues = new Map();
  const queueFor = (name, provider) => {
    if (!queues.has(name)) {
      queues.set(name, createSemaphore(provider.concurrency ?? DEFAULT_CONCURRENCY));
    }
    return queues.get(name);
  };

  router.post('/', async (req, res, next) => {
    const { provider: providerName = 'edge', voice, text } = req.body ?? {};
    // A client that hangs up while its request waits for a slot (a seek, a
    // voice change, a closed tab) no longer wants that audio. Dropping it
    // hands the slot to the chunk the listener is actually waiting on.
    const abandoned = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abandoned.abort();
    });
    try {
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text is required' });
      }
      if (text.length > MAX_TTS_CHARS) {
        return res.status(400).json({ error: `text exceeds ${MAX_TTS_CHARS} characters` });
      }
      if (!voice || typeof voice !== 'string') {
        return res.status(400).json({ error: 'voice is required' });
      }
      const provider = getProvider(providerName);
      if (!provider.available()) {
        return res
          .status(400)
          .json({ error: `Provider "${providerName}" is not configured (missing API key)` });
      }
      // Every provider builds a request from this id — SSML for edge, a file
      // path for supertonic — so it must be one the provider publishes, never
      // a caller-supplied string. Never echo the id back in the error.
      if (!(await provider.isKnownVoice(voice))) {
        return res.status(400).json({ error: `Unknown voice for provider "${providerName}"` });
      }

      const key = cacheKey(providerName, voice, text);
      const cached = await cache.get(key);
      if (cached) {
        return res.json({
          audioBase64: cached.audio.toString('base64'),
          format: cached.format,
          words: cached.words,
          cached: true,
        });
      }

      const timeoutMs = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const retryOnTimeout = provider.retryOnTimeout ?? true;
      const result = await queueFor(providerName, provider).run(
        () =>
          retryOnce(
            () => withTimeout(provider.synthesize({ text, voice }), timeoutMs, 'TTS synthesis'),
            { shouldRetry: (err) => retryOnTimeout || !err.timeout },
          ),
        { signal: abandoned.signal },
      );
      res.json({
        audioBase64: result.audio.toString('base64'),
        format: result.format,
        words: result.words,
        cached: false,
      });
      // Persist after answering. The next queued synthesis starts the moment
      // this one frees its slot, and on-device inference blocks the event
      // loop in long steps, so every await ahead of the reply would wait
      // behind one of them. cache.get serves the entry until the files land.
      cache.put(key, result).catch((err) => {
        console.warn(`Lectern: could not cache TTS audio (${err.message})`);
      });
    } catch (err) {
      if (err.name === 'AbortError' && abandoned.signal.aborted) return; // nobody to answer
      err.status ??= 503;
      err.message = `TTS failed (${providerName}): ${err.message}`;
      next(err);
    }
  });

  return router;
}
