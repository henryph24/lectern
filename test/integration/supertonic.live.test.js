import { describe, it, expect } from 'vitest';
import { synthesize, voices, available, DEFAULT_VOICE } from '../../server/providers/supertonic.js';

const ready = available();
if (!ready) {
  console.warn(
    '\n' +
      '┌──────────────────────────────────────────────────────────────────┐\n' +
      '│  ⚠️  SUPERTONIC LIVE TEST SKIPPED — ONNX assets not downloaded.    │\n' +
      '│  Run `npm run fetch:supertonic` (~398 MB) to enable on-device TTS. │\n' +
      '└──────────────────────────────────────────────────────────────────┘\n',
  );
}

function looksLikeMp3(audio) {
  const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
  const frameSync = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  return id3 || frameSync;
}

describe.skipIf(!ready)('Supertonic — on-device ONNX (assets required)', () => {
  it('lists preset voices', () => {
    const list = voices();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((v) => v.id === DEFAULT_VOICE)).toBe(true);
  });

  // First call loads ~398 MB of ONNX sessions then runs CPU inference — allow time.
  it('synthesizes real mp3 audio with proportional word timings', async () => {
    const text = 'Hello from the on-device integration test.';
    const { audio, format, words } = await synthesize({ text, voice: DEFAULT_VOICE });

    expect(format).toBe('mp3');
    expect(audio.length).toBeGreaterThan(2_000);
    expect(looksLikeMp3(audio)).toBe(true);

    expect(words.length).toBeGreaterThanOrEqual(5);
    expect(words[0].charStart).toBe(0);
    expect(text.slice(words[0].charStart, words[0].charEnd).toLowerCase()).toBe('hello');
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
    }
    expect(words.at(-1).endMs).toBeGreaterThan(1_000);
  }, 180_000);
});
