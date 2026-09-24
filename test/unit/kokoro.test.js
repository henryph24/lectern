import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// onnxruntime-node is mocked: these tests drive the real vendored G2P over a
// tiny dictionary and check everything around the model (tokens in, timings
// out) without the 325 MB weights.
const { fakeOrt } = vi.hoisted(() => ({
  fakeOrt: { create: vi.fn(), run: vi.fn() },
}));

vi.mock('onnxruntime-node', () => ({
  InferenceSession: { create: fakeOrt.create },
  Tensor: class {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
}));

import * as kokoro from '../../server/providers/kokoro.js';

// Every symbol the real Kokoro vocabulary knows; ids here are arbitrary but
// stable. '-' and "'" are absent, as upstream: the tokenizer drops them.
const SYMBOLS = [...';:,.!?—…"()“” ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefhijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ'];
const VOCAB = { $: 0, ...Object.fromEntries(SYMBOLS.map((s, i) => [s, i + 1])) };
const ids = (phonemes) => [...phonemes].map((c) => VOCAB[c]);

const DICTIONARY = [
  ';;; tiny test dictionary',
  'HELLO\thəlˈO',
  'WORLD\twˈɜɹld',
  "WE'RE\twˈiɹ",
  'HERE\thˈiɹ',
  `SUPERCALI\t${'kə'.repeat(300)}`, // 600 tokens: one word longer than the context
].join('\n');

const FRAME_SAMPLES = 600; // 24 kHz / 40 frames per second
const frameMs = (frames) => frames * 25;

// A voice table whose row r is filled with r, so a style tensor names its row.
function voiceTable() {
  const t = new Float32Array(510 * 256);
  for (let r = 0; r < 510; r++) t.fill(r, r * 256, (r + 1) * 256);
  return Buffer.from(t.buffer);
}

// The model predicts `tokenFrames` per phoneme and `padFrames` per pad token;
// the waveform is the rounded frames × 600 samples (what the real decoder
// emits), plus `extraSamples` to force the proportional fallback.
function fakeRun({ tokenFrames = 2, padFrames = 4, extraSamples = 0 } = {}) {
  return async (feeds) => {
    const n = feeds.input_ids.dims[1];
    const durations = new Float32Array(n).fill(tokenFrames);
    durations[0] = padFrames;
    durations[n - 1] = padFrames;
    const frames = Array.from(durations, (d) => Math.max(1, Math.round(d))).reduce((a, b) => a + b, 0);
    const samples = frames * FRAME_SAMPLES + extraSamples;
    const waveform = new Float32Array(samples);
    for (let i = 0; i < samples; i++) waveform[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 24_000);
    return { waveform: { data: waveform, dims: [1, samples] }, durations: { data: durations, dims: [1, n] } };
  };
}

const runFeeds = (call) => fakeOrt.run.mock.calls[call][0];
const inputIds = (call) => Array.from(runFeeds(call).input_ids.data, Number);

function looksLikeMp3(audio) {
  const id3 = audio.subarray(0, 3).toString('latin1') === 'ID3';
  const frameSync = audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0;
  return id3 || frameSync;
}

function expectWellFormed(text, words) {
  for (const w of words) {
    if (w.charStart >= 0) expect(text.slice(w.charStart, w.charEnd)).toBe(w.text);
    expect(w.endMs).toBeGreaterThanOrEqual(w.startMs);
  }
  for (let i = 1; i < words.length; i++) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].startMs);
}

let dir;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kokoro-'));
  mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  mkdirSync(path.join(dir, 'voices'), { recursive: true });
  mkdirSync(path.join(dir, 'dictionaries'), { recursive: true });
  writeFileSync(path.join(dir, 'onnx', 'model.onnx'), 'x');
  writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify({ model: { vocab: VOCAB } }));
  writeFileSync(path.join(dir, 'dictionaries', 'en-us.txt'), DICTIONARY);
  writeFileSync(path.join(dir, 'voices', 'af_heart.bin'), voiceTable());
  writeFileSync(path.join(dir, 'voices', 'am_michael.bin'), voiceTable());
  process.env.KOKORO_DIR = dir;
});

afterAll(() => {
  delete process.env.KOKORO_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  kokoro.resetForTests();
  fakeOrt.create.mockReset().mockResolvedValue({ run: fakeOrt.run });
  fakeOrt.run.mockReset().mockImplementation(fakeRun());
});

describe('kokoro availability and voices', () => {
  it('is available with model, tokenizer, dictionary and a voice on disk', () => {
    expect(kokoro.available()).toBe(true);
  });

  it.each([['onnx/model.onnx'], ['tokenizer.json'], ['dictionaries/en-us.txt']])(
    'is unavailable without %s',
    (rel) => {
      const p = path.join(dir, rel);
      renameSync(p, `${p}.away`);
      try {
        expect(kokoro.available()).toBe(false);
      } finally {
        renameSync(`${p}.away`, p);
      }
    },
  );

  it('is unavailable without any voice file', () => {
    const voices = path.join(dir, 'voices');
    renameSync(voices, `${voices}.away`);
    try {
      expect(kokoro.available()).toBe(false);
      expect(kokoro.voices()).toEqual([]);
    } finally {
      renameSync(`${voices}.away`, voices);
    }
  });

  it('lists only the voices on disk, labelled for the picker', () => {
    expect(kokoro.voices()).toEqual([
      { id: 'af_heart', label: 'Kokoro Heart (en-US)', locale: 'en-US', gender: 'Female' },
      { id: 'am_michael', label: 'Kokoro Michael (en-US)', locale: 'en-US', gender: 'Male' },
    ]);
    expect(kokoro.voices().some((v) => v.id === kokoro.DEFAULT_VOICE)).toBe(true);
  });

  it('does not load onnxruntime until the first synthesis, then keeps one session', async () => {
    kokoro.available();
    kokoro.voices();
    expect(fakeOrt.create).not.toHaveBeenCalled();
    await kokoro.synthesize({ text: 'Hello world', voice: 'af_heart' });
    await kokoro.synthesize({ text: 'Hello there world', voice: 'am_michael' });
    expect(fakeOrt.create).toHaveBeenCalledTimes(1);
    expect(fakeOrt.create).toHaveBeenCalledWith(path.join(dir, 'onnx', 'model.onnx'));
  });
});

describe('kokoro voice validation', () => {
  it('rejects unknown and path-traversal ids with a generic 400, before loading the model', async () => {
    for (const voice of ['../../../package', '../voices/af_heart', 'af_sky', '__proto__']) {
      const err = await kokoro.synthesize({ text: 'Hello', voice }).catch((e) => e);
      expect(err).toMatchObject({ status: 400 });
      expect(err.message).not.toContain(voice);
    }
    expect(fakeOrt.create).not.toHaveBeenCalled();
  });

  it('rejects an allowlisted voice whose file was never fetched', async () => {
    await expect(kokoro.synthesize({ text: 'Hello', voice: 'bf_emma' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('kokoro synthesis', () => {
  it('feeds padded token ids, the style row for the token count, and neutral speed', async () => {
    await kokoro.synthesize({ text: 'Hello world', voice: 'af_heart' });
    const tokens = ids('həlˈO wˈɜɹld');
    expect(inputIds(0)).toEqual([0, ...tokens, 0]);
    const { input_ids, style, speed } = runFeeds(0);
    expect(input_ids).toMatchObject({ type: 'int64', dims: [1, tokens.length + 2] });
    expect(style).toMatchObject({ type: 'float32', dims: [1, 256] });
    expect(style.data.length).toBe(256);
    expect(style.data[0]).toBe(tokens.length); // row n of the voice table
    expect(speed).toMatchObject({ type: 'float32', dims: [1] });
    expect(speed.data[0]).toBe(1);
  });

  it('returns mp3 audio and sample-exact word timings from the rounded durations', async () => {
    // 2.3 / 3.8 frames round to 2 / 4, and the waveform holds exactly the
    // rounded frames, so word edges land on whole frames (25 ms each)
    fakeOrt.run.mockImplementation(fakeRun({ tokenFrames: 2.3, padFrames: 3.8 }));
    const text = 'Hello world';
    const res = await kokoro.synthesize({ text, voice: 'af_heart' });
    expect(res.format).toBe('mp3');
    expect(looksLikeMp3(res.audio)).toBe(true);
    // pad 4 frames, then h ə l ˈ O (5 tokens × 2), a space (2), w ˈ ɜ ɹ l d (6 × 2)
    expect(res.words).toEqual([
      { text: 'Hello', startMs: frameMs(4), endMs: frameMs(14), charStart: 0, charEnd: 5 },
      { text: 'world', startMs: frameMs(16), endMs: frameMs(28), charStart: 6, charEnd: 11 },
    ]);
  });

  it('rescales the predicted durations to the real waveform length when they disagree', async () => {
    // rounded frames (32) no longer account for the audio (36 frames = 900 ms),
    // so the float durations (35.2 frames) are stretched onto the audio
    fakeOrt.run.mockImplementation(fakeRun({ tokenFrames: 2.2, padFrames: 4.4, extraSamples: 4 * FRAME_SAMPLES }));
    const res = await kokoro.synthesize({ text: 'Hello world', voice: 'af_heart' });
    const ms = (frames) => (frames / 35.2) * 900;
    const expected = [
      [ms(4.4), ms(4.4 + 5 * 2.2)],
      [ms(4.4 + 6 * 2.2), ms(4.4 + 12 * 2.2)],
    ];
    res.words.forEach((w, i) => {
      expect(Math.abs(w.startMs - expected[i][0])).toBeLessThanOrEqual(1);
      expect(Math.abs(w.endMs - expected[i][1])).toBeLessThanOrEqual(1);
    });
    expect(res.words.at(-1).endMs).toBeLessThanOrEqual(900);
  });

  it('keeps pauses (punctuation and spaces) out of the word spans', async () => {
    const text = 'Hello, world.';
    const { words } = await kokoro.synthesize({ text, voice: 'af_heart' });
    expect(inputIds(0)).toEqual([0, ...ids('həlˈO, wˈɜɹld.'), 0]);
    // "Hello" ends before the comma (token 5); "world" starts after the space
    // (token 6) and ends before the period (token 13)
    expect(words).toEqual([
      { text: 'Hello', startMs: frameMs(4), endMs: frameMs(14), charStart: 0, charEnd: 5 },
      { text: 'world', startMs: frameMs(18), endMs: frameMs(30), charStart: 7, charEnd: 12 },
    ]);
  });

  it('reads typographic apostrophes as apostrophes and keeps offsets in the original text', async () => {
    const text = 'We’re here';
    const { words } = await kokoro.synthesize({ text, voice: 'af_heart' });
    expect(inputIds(0)).toEqual([0, ...ids('wˈiɹ hˈiɹ'), 0]);
    expect(words.map((w) => [w.text, w.charStart, w.charEnd])).toEqual([
      ['We’re', 0, 5],
      ['here', 6, 10],
    ]);
  });

  it('skips words the G2P cannot voice without losing later offsets', async () => {
    const text = 'Hello 日本 world';
    const { words } = await kokoro.synthesize({ text, voice: 'af_heart' });
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world']);
    expectWellFormed(text, words);
  });

  it.each([
    ['no tokens at all', '日本語'],
    ['only the space between two unvoiced words', '日本 語'],
    // pauses alone make the model emit a burst of noise
    ['only punctuation', '...'],
    ['a lone dash', '—'],
    ['punctuation around unvoiced text', '(日本)'],
  ])('returns a short silent clip, and no words, for text with nothing to voice (%s)', async (_, text) => {
    const res = await kokoro.synthesize({ text, voice: 'af_heart' });
    expect(fakeOrt.run).not.toHaveBeenCalled();
    expect(looksLikeMp3(res.audio)).toBe(true);
    expect(res.audio.length).toBeGreaterThan(1_000); // 300 ms at 128 kbps is ~4.8 KB; an empty stream is under 1 KB
    expect(res).toMatchObject({ format: 'mp3', words: [] });
  });

  it('splits text above the 510-token context at a sentence boundary and keeps every word', async () => {
    // 40 × "Hello world." = 559 tokens; each sentence plus its space is 14
    const text = Array(40).fill('Hello world.').join(' ');
    const { words } = await kokoro.synthesize({ text, voice: 'af_heart' });

    expect(fakeOrt.run).toHaveBeenCalledTimes(2);
    // 36 whole sentences (504 tokens, trailing space trimmed) fit; 510 would
    // cut after a "Hello". Then the remaining 4 sentences.
    expect(inputIds(0).length).toBe(503 + 2);
    expect(inputIds(1).length).toBe(55 + 2);
    expect(runFeeds(0).style.data[0]).toBe(503);
    expect(runFeeds(1).style.data[0]).toBe(55);
    expect(inputIds(1).slice(0, 6)).toEqual([0, ...ids('həlˈO')]);

    expect(words.length).toBe(80);
    expectWellFormed(text, words);
    // piece one lasts 4 + 503 × 2 + 4 = 1014 frames; piece two's first word
    // starts after it plus its own leading pad
    const pieceOneMs = frameMs(1014);
    expect(words[71]).toMatchObject({ text: 'world', endMs: frameMs(4 + 502 * 2) });
    expect(words[72]).toMatchObject({ text: 'Hello', startMs: pieceOneMs + frameMs(4), charStart: 36 * 13 });
    expect(words.at(-1).endMs).toBe(pieceOneMs + frameMs(4 + 54 * 2));
  });

  it('hard-cuts a single word longer than the context and times it across both pieces', async () => {
    const { words } = await kokoro.synthesize({ text: 'Supercali', voice: 'af_heart' });
    expect(fakeOrt.run).toHaveBeenCalledTimes(2);
    expect(inputIds(0).length).toBe(512);
    expect(inputIds(1).length).toBe(90 + 2);
    expect(runFeeds(0).style.data[0]).toBe(509); // clamped to the table's last row
    const pieceOneMs = frameMs(4 + 510 * 2 + 4);
    expect(words).toEqual([
      { text: 'Supercali', startMs: frameMs(4), endMs: pieceOneMs + frameMs(4 + 90 * 2), charStart: 0, charEnd: 9 },
    ]);
  });
});

describe('kokoro number reading', () => {
  // Every model input for `text` (all pieces, pads included), from a fresh call.
  async function modelInput(text) {
    fakeOrt.run.mockClear();
    await kokoro.synthesize({ text, voice: 'af_heart' });
    return fakeOrt.run.mock.calls.flatMap(([feeds]) => Array.from(feeds.input_ids.data, Number));
  }
  const speech = (tokens) => tokens.filter((id) => id !== 0 && id !== VOCAB[' ']);

  it.each([
    ['0.00000001', 'zero point oh oh oh oh oh oh oh one'], // prints as 1e-8: the vendored reader recursed forever
    ['-0.00000001', 'minus zero point oh oh oh oh oh oh oh one'],
    ['0.00000015', 'zero point oh oh oh oh oh oh one five'], // was "one point five undefined undefined seven"
    ['1.10', 'one point one oh'], // the written trailing zero is read
    [
      '3.14159265358979323846', // more decimals than a double holds
      'three point one four one five nine two six five three five eight nine seven nine three two three eight four six',
    ],
    [
      '12345678901234567890', // past 2^53, where a double changes the digits
      'one two three four five six seven eight nine oh one two three four five six seven eight nine oh',
    ],
    // numbers a double holds exactly keep the vendored reading
    ['3.14', 'three point one four'],
    ['1999', 'nineteen ninety nine'],
    ['-5', 'minus five'],
  ])('reads %s as "%s"', async (written, spoken) => {
    expect(await modelInput(written)).toEqual(await modelInput(spoken));
  });

  it('reads an integer too long for a double digit by digit', async () => {
    const text = '9'.repeat(309); // Number(text) is Infinity
    const nine = speech(await modelInput('nine'));
    const input = speech(await modelInput(text));
    expect(new Set(input)).toEqual(new Set(nine));
    expect(input.length).toBe(309 * nine.length);
    const { words } = await kokoro.synthesize({ text, voice: 'af_heart' });
    expect(words).toMatchObject([{ text, charStart: 0, charEnd: 309 }]);
  });

  it('does not overflow the stack on the ordinal of an integer too long for a double', async () => {
    const text = `${'9'.repeat(309)}th`;
    await expect(kokoro.synthesize({ text, voice: 'af_heart' })).resolves.toMatchObject({ format: 'mp3' });
  });
});

describe('kokoro load failures and concurrency', () => {
  it('shares one model load between concurrent first calls', async () => {
    await Promise.all([
      kokoro.synthesize({ text: 'Hello world', voice: 'af_heart' }),
      kokoro.synthesize({ text: 'Hello there', voice: 'am_michael' }),
    ]);
    expect(fakeOrt.create).toHaveBeenCalledTimes(1);
    expect(fakeOrt.run).toHaveBeenCalledTimes(2);
  });

  it('retries a model load that failed', async () => {
    fakeOrt.create.mockRejectedValueOnce(new Error('model read failed'));
    await expect(kokoro.synthesize({ text: 'Hello', voice: 'af_heart' })).rejects.toThrow('model read failed');
    await expect(kokoro.synthesize({ text: 'Hello', voice: 'af_heart' })).resolves.toMatchObject({ format: 'mp3' });
    expect(fakeOrt.create).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed voice file and reads it again once it is replaced', async () => {
    const file = path.join(dir, 'voices', 'bf_emma.bin');
    writeFileSync(file, Buffer.alloc(100)); // not a whole number of 256-float rows
    try {
      await expect(kokoro.synthesize({ text: 'Hello', voice: 'bf_emma' })).rejects.toThrow('malformed');
      writeFileSync(file, voiceTable());
      await expect(kokoro.synthesize({ text: 'Hello', voice: 'bf_emma' })).resolves.toMatchObject({ format: 'mp3' });
    } finally {
      rmSync(file);
    }
  });
});
