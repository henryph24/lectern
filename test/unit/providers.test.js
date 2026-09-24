import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { fakeEdge, fakeEleven, fakeSt } = vi.hoisted(() => ({
  fakeEdge: {
    chunks: [],
    lastArgs: null,
    listVoices: vi.fn(),
  },
  fakeEleven: {
    convertWithTimestamps: vi.fn(),
    search: vi.fn(),
    ctorArgs: [],
  },
  fakeSt: {
    loadTextToSpeech: vi.fn(),
    loadVoiceStyle: vi.fn(),
    call: vi.fn(),
  },
}));

vi.mock('edge-tts-universal', () => ({
  Communicate: class {
    constructor(text, options) {
      fakeEdge.lastArgs = { text, options };
    }
    async *stream() {
      yield* fakeEdge.chunks;
    }
  },
  listVoices: fakeEdge.listVoices,
}));

vi.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: class {
    constructor(opts) {
      fakeEleven.ctorArgs.push(opts);
      this.textToSpeech = { convertWithTimestamps: fakeEleven.convertWithTimestamps };
      this.voices = { search: fakeEleven.search };
    }
  },
}));

// The vendored helper imports onnxruntime-node and loads real ONNX sessions; mock it
// so provider wiring (mp3 encode + proportional words) is unit-tested without weights.
vi.mock('../../server/providers/supertonic/helper.js', () => ({
  loadTextToSpeech: fakeSt.loadTextToSpeech,
  loadVoiceStyle: fakeSt.loadVoiceStyle,
}));

import * as edge from '../../server/providers/edge.js';
import * as elevenlabs from '../../server/providers/elevenlabs.js';
import * as supertonic from '../../server/providers/supertonic.js';
import * as kokoro from '../../server/providers/kokoro.js';
import { getProvider, providers } from '../../server/providers/index.js';

describe('edge provider', () => {
  beforeEach(() => {
    fakeEdge.chunks = [
      { type: 'audio', data: Buffer.from('abc') },
      { type: 'WordBoundary', offset: 1_000_000, duration: 2_000_000, text: 'Hello' },
      { type: 'audio', data: Buffer.from('def') },
      { type: 'WordBoundary', offset: 4_000_000, duration: 1_000_000, text: 'world' },
      { type: 'SentenceBoundary', offset: 0, duration: 0, text: 'Hello world' },
    ];
  });

  it('concatenates audio and converts 100ns ticks to ms word timings', async () => {
    const result = await edge.synthesize({ text: 'Hello world', voice: 'en-US-AriaNeural' });
    expect(result.audio.toString()).toBe('abcdef');
    expect(result.format).toBe('mp3');
    expect(result.words).toEqual([
      { text: 'Hello', startMs: 100, endMs: 300, charStart: 0, charEnd: 5 },
      { text: 'world', startMs: 400, endMs: 500, charStart: 6, charEnd: 11 },
    ]);
    expect(fakeEdge.lastArgs.options.voice).toBe('en-US-AriaNeural');
  });

  it('uses the default voice when none is given', async () => {
    await edge.synthesize({ text: 'Hello world' });
    expect(fakeEdge.lastArgs.options.voice).toBe(edge.DEFAULT_VOICE);
  });

  it('throws when no audio chunks arrive', async () => {
    fakeEdge.chunks = [{ type: 'WordBoundary', offset: 0, duration: 1, text: 'x' }];
    await expect(edge.synthesize({ text: 'x' })).rejects.toThrow('no audio');
  });

  it('filters the curated voice list against live voices and labels them', async () => {
    fakeEdge.listVoices.mockResolvedValue([
      { ShortName: 'en-US-AvaMultilingualNeural', Locale: 'en-US', Gender: 'Female', FriendlyName: 'Ava' },
      { ShortName: 'xx-XX-UnknownNeural', Locale: 'xx-XX', Gender: 'Male', FriendlyName: 'Unknown' },
    ]);
    const curated = await edge.voices();
    expect(curated).toEqual([
      { id: 'en-US-AvaMultilingualNeural', label: 'Ava (en-US)', locale: 'en-US', gender: 'Female' },
    ]);
    const all = await edge.voices({ all: true });
    expect(all.length).toBe(2);
    expect(fakeEdge.listVoices).toHaveBeenCalledTimes(1); // 24h in-memory cache
  });
});

describe('elevenlabs provider', () => {
  beforeEach(() => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    elevenlabs.resetClientForTests();
  });

  it('reports availability from the environment', () => {
    expect(elevenlabs.available()).toBe(true);
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    expect(elevenlabs.available()).toBe(false);
  });

  it('decodes base64 audio and aggregates alignment into words', async () => {
    const text = 'Hi there';
    const characters = [...text];
    fakeEleven.convertWithTimestamps.mockResolvedValue({
      audioBase64: Buffer.from('AUDIO').toString('base64'),
      alignment: {
        characters,
        characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
        characterEndTimesSeconds: characters.map((_, i) => i * 0.1 + 0.1),
      },
    });
    const result = await elevenlabs.synthesize({ text, voice: 'voice-1' });
    expect(result.audio.toString()).toBe('AUDIO');
    expect(result.words.map((w) => w.text)).toEqual(['Hi', 'there']);
    expect(fakeEleven.convertWithTimestamps).toHaveBeenCalledWith('voice-1', {
      text,
      modelId: elevenlabs.DEFAULT_MODEL,
      outputFormat: 'mp3_44100_128',
    });
  });

  it('returns empty words when alignment is missing', async () => {
    fakeEleven.convertWithTimestamps.mockResolvedValue({
      audioBase64: Buffer.from('X').toString('base64'),
    });
    const result = await elevenlabs.synthesize({ text: 'x', voice: 'v' });
    expect(result.words).toEqual([]);
  });

  it('lists voices via search', async () => {
    fakeEleven.search.mockResolvedValue({
      voices: [{ voiceId: 'v1', name: 'Rachel', labels: { language: 'en', gender: 'female' } }],
    });
    expect(await elevenlabs.voices()).toEqual([
      { id: 'v1', label: 'Rachel', locale: 'en', gender: 'female' },
    ]);
  });
});

describe('supertonic provider', () => {
  let dir;
  const ONNX = ['duration_predictor.onnx', 'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx', 'tts.json', 'unicode_indexer.json'];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'supertonic-'));
    mkdirSync(path.join(dir, 'onnx'), { recursive: true });
    mkdirSync(path.join(dir, 'voice_styles'), { recursive: true });
    for (const f of ONNX) writeFileSync(path.join(dir, 'onnx', f), 'x');
    writeFileSync(path.join(dir, 'voice_styles', 'M1.json'), '{}');
    writeFileSync(path.join(dir, 'voice_styles', 'F1.json'), '{}');
    process.env.SUPERTONIC_DIR = dir;
  });

  afterAll(() => {
    delete process.env.SUPERTONIC_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    supertonic.resetForTests();
    fakeSt.loadTextToSpeech.mockReset();
    fakeSt.loadVoiceStyle.mockReset();
    fakeSt.call.mockReset();
  });

  it('available() is true with assets present; voices() lists only on-disk styles', async () => {
    expect(supertonic.available()).toBe(true);
    const v = await supertonic.voices();
    expect(v.map((x) => x.id).sort()).toEqual(['F1', 'M1']);
    expect(v.find((x) => x.id === 'M1')).toMatchObject({ label: 'Supertonic Male 1', gender: 'Male', locale: 'multi' });
  });

  it('available() is false when a required onnx file is missing', () => {
    rmSync(path.join(dir, 'onnx', 'vocoder.onnx'));
    expect(supertonic.available()).toBe(false);
    writeFileSync(path.join(dir, 'onnx', 'vocoder.onnx'), 'x'); // restore for later tests
  });

  it('synthesizes mp3 audio and proportional word timings', async () => {
    const sr = 44100;
    const n = Math.floor(sr * 0.5);
    const wav = new Float32Array(n);
    for (let i = 0; i < n; i++) wav[i] = 0.2 * Math.sin((2 * Math.PI * 330 * i) / sr);
    fakeSt.loadTextToSpeech.mockResolvedValue({ sampleRate: sr, call: fakeSt.call });
    fakeSt.loadVoiceStyle.mockReturnValue({ ttl: { dims: [1] } });
    fakeSt.call.mockResolvedValue({ wav, duration: [0.5] });

    const res = await supertonic.synthesize({ text: 'Hello there world.', voice: 'M1' });

    expect(res.format).toBe('mp3');
    const id3 = res.audio.subarray(0, 3).toString('latin1') === 'ID3';
    const frameSync = res.audio[0] === 0xff && (res.audio[1] & 0xe0) === 0xe0;
    expect(id3 || frameSync).toBe(true);
    expect(res.words.map((w) => w.text)).toEqual(['Hello', 'there', 'world']);
    expect(res.words[0].charStart).toBe(0);
    expect(res.words.at(-1).endMs).toBeLessThanOrEqual(500);
    expect(fakeSt.call).toHaveBeenCalledWith('Hello there world.', 'en', expect.anything(), 8, 1.0);
  });

  it('rejects an unknown voice with status 400', async () => {
    fakeSt.loadTextToSpeech.mockResolvedValue({ sampleRate: 44100, call: fakeSt.call });
    await expect(supertonic.synthesize({ text: 'hi', voice: 'ZZ' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('provider registry', () => {
  it('resolves known providers and rejects unknown ones with status 400', () => {
    expect(getProvider('edge')).toBe(providers.edge);
    expect(getProvider('elevenlabs')).toBe(providers.elevenlabs);
    expect(getProvider('supertonic')).toBe(providers.supertonic);
    expect(getProvider('kokoro')).toBe(providers.kokoro);
    expect(() => getProvider('nope')).toThrowError(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('edge is always available; elevenlabs follows the env key', () => {
    expect(providers.edge.available()).toBe(true);
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    expect(providers.elevenlabs.available()).toBe(false);
    vi.stubEnv('ELEVENLABS_API_KEY', 'k');
    expect(providers.elevenlabs.available()).toBe(true);
  });

  it('declares a synthesis latency profile per provider', () => {
    // network providers: tight ceiling, retry anything (transient blips)
    expect(providers.edge).toMatchObject({ timeoutMs: 20_000, retryOnTimeout: true });
    expect(providers.elevenlabs).toMatchObject({ timeoutMs: 20_000, retryOnTimeout: true });
    // on-device: far larger ceiling, and never retry a timeout (abandoned
    // inference keeps burning CPU, so a retry would race and slow both attempts)
    expect(providers.supertonic.retryOnTimeout).toBe(false);
    expect(providers.supertonic.timeoutMs).toBeGreaterThanOrEqual(60_000);
    expect(providers.kokoro).toMatchObject({ timeoutMs: 120_000, retryOnTimeout: false });
  });

  it('wires kokoro to its provider module', () => {
    expect(providers.kokoro).toMatchObject({
      synthesize: kokoro.synthesize,
      voices: kokoro.voices,
      isKnownVoice: kokoro.isKnownVoice,
      available: kokoro.available,
    });
  });

  it('declares how many syntheses may run at once per provider', () => {
    // network providers overlap well
    expect(providers.edge.concurrency).toBe(2);
    expect(providers.elevenlabs.concurrency).toBe(2);
    // on-device inference interleaves step by step, so run it one at a time
    expect(providers.supertonic.concurrency).toBe(1);
  });
});
