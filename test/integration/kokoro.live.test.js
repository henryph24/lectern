import { describe, it, expect } from 'vitest';
import { synthesize, voices, available, DEFAULT_VOICE } from '../../server/providers/kokoro.js';

const ready = available();
if (!ready) {
  console.warn(
    '\n' +
      '┌──────────────────────────────────────────────────────────────────┐\n' +
      '│  ⚠️  KOKORO LIVE TEST SKIPPED: model assets not downloaded.         │\n' +
      '│  Run `npm run fetch:kokoro` (~333 MB) to enable on-device TTS.     │\n' +
      '└──────────────────────────────────────────────────────────────────┘\n',
  );
}

function looksLikeMp3(audio) {
  const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
  const frameSync = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  return id3 || frameSync;
}

// Duration of the provider's mp3 by walking its frame headers. Kokoro audio is
// 24 kHz mono, which lamejs writes as MPEG-2 Layer III: 576 samples a frame.
const MPEG2_L3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG2_RATES = [22_050, 24_000, 16_000];
function mp3DurationMs(buf) {
  let frames = 0;
  let rate = 0;
  let i = 0;
  while (i + 4 <= buf.length) {
    // 11 sync bits, version 10 (MPEG-2), layer 01 (III); the CRC bit is free
    const isHeader = buf[i] === 0xff && (buf[i + 1] & 0xfe) === 0xf2;
    const kbps = MPEG2_L3_KBPS[buf[i + 2] >> 4];
    rate = MPEG2_RATES[(buf[i + 2] >> 2) & 3];
    if (!isHeader || !kbps || !rate) break;
    frames++;
    i += Math.floor((72_000 * kbps) / rate) + ((buf[i + 2] >> 1) & 1);
  }
  expect(i).toBe(buf.length); // every byte belongs to a frame
  return ((frames * 576) / rate) * 1000;
}

describe.skipIf(!ready)('Kokoro: on-device ONNX (assets required)', () => {
  it('lists preset voices including the default', () => {
    const list = voices();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((v) => v.id === DEFAULT_VOICE)).toBe(true);
  });

  // First call loads the 325 MB model and the 125k-entry dictionary, then runs
  // CPU inference, so allow time.
  it('synthesizes real mp3 audio with word timings from the model durations', async () => {
    const text =
      'Kokoro reads this paragraph on your own machine. Each word is timed from the phoneme durations the model predicts, ' +
      'so the highlight follows the voice. Nothing leaves the computer.';
    const { audio, format, words } = await synthesize({ text, voice: DEFAULT_VOICE });

    expect(format).toBe('mp3');
    expect(audio.length).toBeGreaterThan(2_000);
    expect(looksLikeMp3(audio)).toBe(true);
    const audioMs = mp3DurationMs(audio);
    expect(audioMs).toBeGreaterThan(5_000);

    const textWords = [...new Intl.Segmenter('en', { granularity: 'word' }).segment(text)].filter((s) => s.isWordLike);
    expect(Math.abs(words.length - textWords.length)).toBeLessThanOrEqual(1);
    for (const w of words) {
      expect(w.charStart).toBeGreaterThanOrEqual(0);
      expect(text.slice(w.charStart, w.charEnd)).toBe(w.text);
      expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
    }
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
      expect(words[i].charStart).toBeGreaterThanOrEqual(words[i - 1].charEnd);
    }
    // the last word ends near the end of the audio: only trailing silence follows
    expect(words.at(-1).endMs).toBeLessThanOrEqual(audioMs);
    expect(words.at(-1).endMs).toBeGreaterThanOrEqual(audioMs * 0.85);
  }, 180_000);
});
