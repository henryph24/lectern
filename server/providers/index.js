import * as edge from './edge.js';
import * as elevenlabs from './elevenlabs.js';
import * as supertonic from './supertonic.js';
import * as kokoro from './kokoro.js';

// Each provider declares its own synthesis latency profile. Network providers
// (edge, elevenlabs) return in a few seconds or fail fast, so a tight timeout
// with retry-on-anything is right. Supertonic (ONNX diffusion) and Kokoro (ONNX
// StyleTTS 2) run on-device: CPU-bound and much slower, especially for long
// chunks, so they need a far larger ceiling; and because a timed-out inference
// is uncancelable and keeps using CPU, they must never be retried on timeout (a
// second attempt would race the abandoned first one and slow both down).
// `concurrency` is how many syntheses of one provider run at once; each
// provider gets its own queue. Network providers overlap well. onnxruntime-node
// runs each inference step synchronously and yields between steps, so two
// on-device requests interleave step by step and both finish late: one at a
// time delivers the chunk the listener is waiting on about twice as soon
// (3.6 s vs 7.4 s measured for Supertonic) for the same total throughput.
// `timeoutMs`/`retryOnTimeout`/`concurrency` are consumed by routes/tts.js.
export const providers = {
  edge: {
    synthesize: edge.synthesize,
    voices: edge.voices,
    isKnownVoice: edge.isKnownVoice,
    available: () => true,
    timeoutMs: 20_000,
    retryOnTimeout: true,
    concurrency: 2,
  },
  elevenlabs: {
    synthesize: elevenlabs.synthesize,
    voices: elevenlabs.voices,
    isKnownVoice: elevenlabs.isKnownVoice,
    available: elevenlabs.available,
    timeoutMs: 20_000,
    retryOnTimeout: true,
    concurrency: 2,
  },
  supertonic: {
    synthesize: supertonic.synthesize,
    voices: supertonic.voices,
    isKnownVoice: supertonic.isKnownVoice,
    available: supertonic.available,
    timeoutMs: 120_000,
    retryOnTimeout: false,
    concurrency: 1,
  },
  kokoro: {
    synthesize: kokoro.synthesize,
    voices: kokoro.voices,
    isKnownVoice: kokoro.isKnownVoice,
    available: kokoro.available,
    timeoutMs: 120_000,
    retryOnTimeout: false,
    concurrency: 1,
  },
};

export function getProvider(name) {
  // hasOwnProperty, not providers[name]: '__proto__', 'constructor' and
  // 'toString' are all truthy on a plain object and would sail past the guard
  // below, turning a bad request into a 5xx plus a stack trace in the log.
  const provider = Object.prototype.hasOwnProperty.call(providers, name) ? providers[name] : null;
  if (!provider) {
    throw Object.assign(new Error(`Unknown provider: ${name}`), { status: 400 });
  }
  return provider;
}
