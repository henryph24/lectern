import { describe, it, expect } from 'vitest';
import { synthesize, voices, available } from '../../server/providers/elevenlabs.js';

const hasKey = available();
if (!hasKey) {
  console.warn(
    '\n' +
      '┌──────────────────────────────────────────────────────────────────┐\n' +
      '│  ⚠️  ELEVENLABS LIVE TEST SKIPPED — no ELEVENLABS_API_KEY found.   │\n' +
      '│  Add it to .env to exercise the real ElevenLabs API.              │\n' +
      '└──────────────────────────────────────────────────────────────────┘\n',
  );
}

describe.skipIf(!hasKey)('ElevenLabs — live service', () => {
  it('lists voices and synthesizes audio with word timestamps', async () => {
    const list = await voices();
    expect(list.length).toBeGreaterThan(0);

    const { audio, format, words } = await synthesize({
      text: 'Hello from the integration test.',
      voice: list[0].id,
    });
    expect(format).toBe('mp3');
    expect(audio.length).toBeGreaterThan(2_000);
    const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
    const frameSync = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
    expect(id3 || frameSync).toBe(true);
    expect(words.length).toBeGreaterThanOrEqual(4);
    expect(words[0].charStart).toBe(0);
  });
});
