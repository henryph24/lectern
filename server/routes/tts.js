import { performance } from 'node:perf_hooks';
import { Router } from 'express';
import { getProvider } from '../providers/index.js';
import { cacheKey } from '../lib/cache.js';
import { createPacer } from '../lib/pacer.js';
import { createSemaphore, withTimeout, retryOnce } from '../lib/semaphore.js';

const MAX_TTS_CHARS = 2000;
const MAX_RATE = 4;
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
  // One pacer per provider that declares a step range (on-device diffusion): it
  // learns this machine's speed and picks the steps that keep up with the
  // listener's playback rate. See lib/pacer.js.
  const pacers = new Map();
  const pacerFor = (name, provider) => {
    if (!provider.steps) return null;
    if (!pacers.has(name)) pacers.set(name, createPacer(provider.steps));
    return pacers.get(name);
  };

  // The provider's default step count keeps the original cache key; fewer steps
  // are a variant of the same text.
  const keyFor = (name, provider, voice, text, steps) =>
    cacheKey(name, voice, text, steps == null || steps === provider.steps?.max ? null : { steps });

  // Any cached synthesis of this text beats synthesizing it again, and the one
  // with the most steps wins. The lookups run together: on-device inference
  // blocks the event loop in long steps, so each sequential await could wait
  // behind one.
  async function findCached(name, provider, voice, text) {
    const steps = provider.steps;
    const keys = [keyFor(name, provider, voice, text, null)];
    if (steps) for (let n = steps.max - 1; n >= steps.min; n--) keys.push(keyFor(name, provider, voice, text, n));
    const hits = await Promise.all(keys.map((key) => cache.get(key)));
    return hits.find(Boolean) ?? null;
  }

  router.post('/', async (req, res, next) => {
    const { provider: providerName = 'edge', voice, text, rate = 1 } = req.body ?? {};
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
      // the listener's playback rate; it only paces on-device work
      if (typeof rate !== 'number' || !(rate > 0 && rate <= MAX_RATE)) {
        return res.status(400).json({ error: `rate must be a number above 0 and at most ${MAX_RATE}` });
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

      const cached = await findCached(providerName, provider, voice, text);
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
      const pacer = pacerFor(providerName, provider);
      const result = await queueFor(providerName, provider).run(
        async () => {
          // The same text may have been synthesized while this request waited
          // for its slot (a rehydrated player asking again for the chunk it lost).
          const landed = await findCached(providerName, provider, voice, text);
          if (landed) return { ...landed, cached: true };
          const steps = pacer?.stepsFor(rate);
          const args = steps == null ? { text, voice } : { text, voice, steps };
          const attempt = async () => {
            const started = performance.now();
            const out = await withTimeout(provider.synthesize(args), timeoutMs, 'TTS synthesis');
            return { out, ms: performance.now() - started };
          };
          const { out, ms } = await retryOnce(attempt, {
            shouldRetry: (err) => retryOnTimeout || !err.timeout,
          });
          pacer?.record({ steps, synthMs: ms, audioMs: out.durationMs });
          // Hand the audio to the cache before the slot frees, so a request
          // queued behind this one for the same text finds it. put() records it
          // in memory at once and writes the files in the background; the reply
          // never waits for them, because on-device inference blocks the event
          // loop in long steps and every await ahead of the reply would wait
          // behind one of them.
          cache.put(keyFor(providerName, provider, voice, text, steps), out).catch((err) => {
            console.warn(`Lectern: could not cache TTS audio (${err.message})`);
          });
          return { ...out, cached: false };
        },
        { signal: abandoned.signal },
      );
      res.json({
        audioBase64: result.audio.toString('base64'),
        format: result.format,
        words: result.words,
        cached: result.cached,
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
