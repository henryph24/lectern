import { describe, it, expect } from 'vitest';
import { synthesize, voices, DEFAULT_VOICE } from '../../server/providers/edge.js';

function looksLikeMp3(audio) {
  const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
  const frameSync = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  return id3 || frameSync;
}

describe('Edge TTS — live service (keyless, always runs)', () => {
  it('synthesizes real audio with word boundaries', async () => {
    const text = 'Hello from the integration test suite.';
    const { audio, format, words } = await synthesize({ text, voice: DEFAULT_VOICE });

    expect(format).toBe('mp3');
    expect(audio.length).toBeGreaterThan(5_000);
    expect(looksLikeMp3(audio)).toBe(true);

    expect(words.length).toBeGreaterThanOrEqual(5);
    expect(words[0].text.toLowerCase()).toBe('hello');
    expect(words[0].charStart).toBe(0);
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
    }
    expect(words.at(-1).endMs).toBeGreaterThan(1_000);
  });

  it('lists live voices including the curated defaults', async () => {
    const curated = await voices();
    expect(curated.length).toBeGreaterThanOrEqual(5);
    expect(curated.some((v) => v.id === DEFAULT_VOICE)).toBe(true);
    const all = await voices({ all: true });
    expect(all.length).toBeGreaterThan(100);
  });
});
