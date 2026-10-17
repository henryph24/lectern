// Picks how many denoising steps an on-device synthesis may spend, so the engine
// stays ahead of the listener on whatever machine it runs on and under whatever
// load that machine carries.
//
// Cost model, measured on Supertonic: synthMs ≈ k · (steps + FIXED_STEPS) · audioMs.
// Each denoising step costs the same per ms of audio, and the encoders plus the
// vocoder cost about half a step. k is this machine's cost per step per ms of
// audio. It moves with machine load (0.055 on an idle M3 Pro, 0.12 with a screen
// recorder and busy browser tabs running), so every synthesis re-estimates it.
//
// The listener spends audioMs / rate on a chunk, and the engine must produce the
// next one in that time. Steps are chosen so synthesis uses at most TARGET of it,
// which leaves room for jitter and lets the client's prefetch buffer grow.
const TARGET = 0.6;
const FIXED_STEPS = 0.5;
const INITIAL_K = 0.06;
const ALPHA = 0.3;
// A short clip is dominated by per-call overhead, so it moves the estimate less.
const FULL_WEIGHT_MS = 10_000;

export function createPacer({ min, max }) {
  let k = INITIAL_K;
  return {
    stepsFor(rate) {
      const steps = Math.floor(TARGET / (rate * k) - FIXED_STEPS);
      return Math.min(max, Math.max(min, steps));
    },
    record({ steps, synthMs, audioMs }) {
      if (!(audioMs > 0) || !(synthMs >= 0)) return;
      const sample = synthMs / ((steps + FIXED_STEPS) * audioMs);
      k += ALPHA * Math.min(1, audioMs / FULL_WEIGHT_MS) * (sample - k);
    },
    get k() {
      return k;
    },
  };
}
