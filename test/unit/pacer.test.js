import { describe, it, expect } from 'vitest';
import { createPacer } from '../../server/lib/pacer.js';

const steps = { min: 2, max: 8 };

describe('createPacer', () => {
  it('spends the full step budget at 1x on a machine as fast as the default estimate', () => {
    const pacer = createPacer(steps);
    expect(pacer.stepsFor(1)).toBe(8);
  });

  it('cuts steps as the playback rate rises, so synthesis stays ahead of the listener', () => {
    const pacer = createPacer(steps);
    const atRates = [1, 1.5, 2, 2.5, 3].map((rate) => pacer.stepsFor(rate));
    expect(atRates).toEqual([8, 6, 4, 3, 2]);
  });

  it('keeps predicted synthesis time within the target share of the playback time', () => {
    const pacer = createPacer(steps);
    for (const rate of [1, 1.25, 1.5, 2, 2.5]) {
      const s = pacer.stepsFor(rate);
      // cost per ms of audio, divided by the ms the listener spends on it
      expect(pacer.k * (s + 0.5) * rate).toBeLessThanOrEqual(0.6);
    }
  });

  it('never goes below the minimum or above the maximum', () => {
    const pacer = createPacer(steps);
    expect(pacer.stepsFor(0.5)).toBe(8);
    expect(pacer.stepsFor(4)).toBe(2);
    pacer.record({ steps: 8, synthMs: 1_000_000, audioMs: 10_000 }); // a machine 100x too slow
    expect(pacer.stepsFor(1)).toBe(2);
  });

  it('drops steps after slow syntheses and recovers when the machine frees up', () => {
    const pacer = createPacer(steps);
    // a loaded machine: 1 s of compute per s of audio at 8 steps (k ≈ 0.118)
    for (let i = 0; i < 6; i++) pacer.record({ steps: 8, synthMs: 15_000, audioMs: 15_000 });
    const loaded = pacer.stepsFor(2);
    expect(loaded).toBe(2);
    expect(pacer.stepsFor(1)).toBeLessThan(8);
    // the load goes away: 3 s per 15 s of audio at 2 steps (k = 0.08), then quieter still
    for (let i = 0; i < 12; i++) pacer.record({ steps: 2, synthMs: 1_500, audioMs: 15_000 });
    expect(pacer.stepsFor(2)).toBeGreaterThan(loaded);
  });

  it('weights a short clip less, since per-call overhead dominates it', () => {
    const long = createPacer(steps);
    const short = createPacer(steps);
    const before = long.k;
    // both samples measure the same slow cost per ms of audio
    long.record({ steps: 8, synthMs: 85_000, audioMs: 10_000 });
    short.record({ steps: 8, synthMs: 8_500, audioMs: 1_000 });
    expect(long.k).toBeGreaterThan(short.k);
    expect(short.k).toBeGreaterThan(before);
  });

  it('ignores a sample that carries no audio length', () => {
    const pacer = createPacer(steps);
    const before = pacer.k;
    pacer.record({ steps: 8, synthMs: 5_000, audioMs: 0 });
    pacer.record({ steps: 8, synthMs: 5_000, audioMs: undefined });
    pacer.record({ steps: 8, synthMs: Number.NaN, audioMs: 10_000 });
    expect(pacer.k).toBe(before);
  });
});
