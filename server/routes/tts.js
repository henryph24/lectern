import { Router } from 'express';
import { getProvider } from '../providers/index.js';
import { cacheKey } from '../lib/cache.js';
import { createSemaphore, withTimeout, retryOnce } from '../lib/semaphore.js';

const MAX_TTS_CHARS = 2000;
// Fallback when a provider doesn't declare its own; real timeouts live in
// providers/index.js because they're provider-specific (network vs on-device).
const DEFAULT_TIMEOUT_MS = 20_000;

export function ttsRouter({ cache }) {
  const router = Router();
  const semaphore = createSemaphore(2);

  router.post('/', async (req, res, next) => {
    const { provider: providerName = 'edge', voice, text } = req.body ?? {};
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
      const result = await semaphore.run(() =>
        retryOnce(
          () => withTimeout(provider.synthesize({ text, voice }), timeoutMs, 'TTS synthesis'),
          { shouldRetry: (err) => retryOnTimeout || !err.timeout },
        ),
      );
      await cache.put(key, result);
      res.json({
        audioBase64: result.audio.toString('base64'),
        format: result.format,
        words: result.words,
        cached: false,
      });
    } catch (err) {
      err.status ??= 503;
      err.message = `TTS failed (${providerName}): ${err.message}`;
      next(err);
    }
  });

  return router;
}
