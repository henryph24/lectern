import * as edge from './edge.js';
import * as elevenlabs from './elevenlabs.js';
import * as supertonic from './supertonic.js';

// Each provider declares its own synthesis latency profile. Network providers
// (edge, elevenlabs) return in a few seconds or fail fast, so a tight timeout
// with retry-on-anything is right. Supertonic is on-device ONNX diffusion —
// CPU-bound and much slower, especially for long chunks — so it needs a far
// larger ceiling; and because a timed-out inference is uncancelable and keeps
// using CPU, it must never be retried on timeout (a second attempt would race
// the abandoned first one and slow both down). `timeoutMs`/`retryOnTimeout` are
// consumed by routes/tts.js.
export const providers = {
  edge: {
    synthesize: edge.synthesize,
    voices: edge.voices,
    isKnownVoice: edge.isKnownVoice,
    available: () => true,
    timeoutMs: 20_000,
    retryOnTimeout: true,
  },
  elevenlabs: {
    synthesize: elevenlabs.synthesize,
    voices: elevenlabs.voices,
    isKnownVoice: elevenlabs.isKnownVoice,
    available: elevenlabs.available,
    timeoutMs: 20_000,
    retryOnTimeout: true,
  },
  supertonic: {
    synthesize: supertonic.synthesize,
    voices: supertonic.voices,
    isKnownVoice: supertonic.isKnownVoice,
    available: supertonic.available,
    timeoutMs: 120_000,
    retryOnTimeout: false,
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
