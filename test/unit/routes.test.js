import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { pdfWithPages } from '../fixtures/pdf-builder.mjs';

const mocks = vi.hoisted(() => ({
  edgeSynthesize: vi.fn(),
  edgeVoices: vi.fn(),
  elevenAvailable: vi.fn(() => false),
  kokoroAvailable: vi.fn(() => false),
  kokoroVoices: vi.fn(() => []),
  // per-provider synthesis policy, flippable per test (reset in beforeEach)
  edgeTimeoutMs: 20_000,
  edgeRetryOnTimeout: true,
  edgeConcurrency: 2,
  elevenSynthesize: vi.fn(),
  elevenTimeoutMs: 20_000,
}));

vi.mock('../../server/providers/index.js', () => {
  const providers = {
    edge: {
      synthesize: mocks.edgeSynthesize,
      voices: mocks.edgeVoices,
      isKnownVoice: vi.fn(async (id) => id !== 'not-a-published-voice'),
      available: () => true,
      get timeoutMs() {
        return mocks.edgeTimeoutMs;
      },
      get retryOnTimeout() {
        return mocks.edgeRetryOnTimeout;
      },
      get concurrency() {
        return mocks.edgeConcurrency;
      },
    },
    elevenlabs: {
      synthesize: mocks.elevenSynthesize,
      voices: vi.fn(async () => []),
      isKnownVoice: vi.fn(async () => true),
      available: mocks.elevenAvailable,
      get timeoutMs() {
        return mocks.elevenTimeoutMs;
      },
    },
    supertonic: {
      synthesize: vi.fn(),
      voices: vi.fn(() => []),
      isKnownVoice: vi.fn(() => true),
      available: () => false,
    },
    kokoro: {
      synthesize: vi.fn(),
      voices: mocks.kokoroVoices,
      isKnownVoice: vi.fn(() => true),
      available: mocks.kokoroAvailable,
    },
  };
  return {
    providers,
    getProvider(name) {
      const provider = providers[name];
      if (!provider) throw Object.assign(new Error(`Unknown provider: ${name}`), { status: 400 });
      return provider;
    },
  };
});

import express from 'express';
import { createApp } from '../../server/app.js';
import { ttsRouter } from '../../server/routes/tts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, '..', 'fixtures', name);

let app;
let dataDir;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'speechify-data-'));
  app = createApp({ dataDir });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.edgeSynthesize.mockReset();
  mocks.edgeVoices.mockReset().mockResolvedValue([
    { id: 'en-US-AvaMultilingualNeural', label: 'Ava (en-US)', locale: 'en-US', gender: 'Female' },
  ]);
  mocks.elevenAvailable.mockReturnValue(false);
  mocks.kokoroAvailable.mockReset().mockReturnValue(false);
  mocks.kokoroVoices.mockReset().mockReturnValue([]);
  mocks.edgeTimeoutMs = 20_000;
  mocks.edgeRetryOnTimeout = true;
  mocks.edgeConcurrency = 2;
  mocks.elevenSynthesize.mockReset();
  mocks.elevenTimeoutMs = 20_000;
});

const importText = (text, title) =>
  request(app).post('/api/docs/import/text').send({ text, ...(title ? { title } : {}) });

describe('POST /api/tts', () => {
  const words = [{ text: 'Hi', startMs: 0, endMs: 200, charStart: 0, charEnd: 2 }];

  it('validates input', async () => {
    expect((await request(app).post('/api/tts').send({ voice: 'v' })).status).toBe(400);
    expect((await request(app).post('/api/tts').send({ text: 'hi' })).status).toBe(400);
    expect(
      (await request(app).post('/api/tts').send({ text: 'x'.repeat(2001), voice: 'v' })).status,
    ).toBe(400);
    expect(
      (await request(app).post('/api/tts').send({ provider: 'nope', text: 'hi', voice: 'v' }))
        .status,
    ).toBe(400);
  });

  it('rejects unconfigured providers', async () => {
    const res = await request(app)
      .post('/api/tts')
      .send({ provider: 'elevenlabs', text: 'hi', voice: 'v' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not configured');
  });

  it('rejects a voice the provider does not publish', async () => {
    // The id reaches the provider's own request builder (SSML for edge, a file
    // path for supertonic), so an arbitrary string must never get that far.
    const res = await request(app)
      .post('/api/tts')
      .send({ provider: 'edge', voice: 'not-a-published-voice', text: 'Hello there.' });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toContain('not-a-published-voice');
    expect(mocks.edgeSynthesize).not.toHaveBeenCalled();
  });

  it('synthesizes once and serves the disk cache afterwards', async () => {
    mocks.edgeSynthesize.mockResolvedValue({ audio: Buffer.from('AUDIO-BYTES'), format: 'mp3', words });
    const body = { provider: 'edge', voice: 'en-US-AriaNeural', text: 'Cache me once.' };

    const first = await request(app).post('/api/tts').send(body);
    expect(first.status).toBe(200);
    expect(Buffer.from(first.body.audioBase64, 'base64').toString()).toBe('AUDIO-BYTES');
    expect(first.body).toMatchObject({ format: 'mp3', cached: false, words });

    const second = await request(app).post('/api/tts').send(body);
    expect(second.status).toBe(200);
    expect(second.body.cached).toBe(true);
    expect(mocks.edgeSynthesize).toHaveBeenCalledTimes(1);
  });

  it('retries once then surfaces a 503 on provider failure', async () => {
    mocks.edgeSynthesize.mockRejectedValue(new Error('socket hiccup'));
    const res = await request(app)
      .post('/api/tts')
      .send({ provider: 'edge', voice: 'v', text: 'This will fail.' });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('socket hiccup');
    expect(mocks.edgeSynthesize).toHaveBeenCalledTimes(2);
  });

  it('times out a stuck synthesis at the provider-declared deadline', async () => {
    mocks.edgeTimeoutMs = 40;
    mocks.edgeSynthesize.mockImplementation(() => new Promise(() => {})); // never settles
    const res = await request(app)
      .post('/api/tts')
      .send({ provider: 'edge', voice: 'v', text: 'Stuck synth.' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/timed out after 40ms/);
  });

  it('does not retry a timeout when the provider opts out (on-device profile)', async () => {
    mocks.edgeRetryOnTimeout = false;
    mocks.edgeTimeoutMs = 40;
    mocks.edgeSynthesize.mockImplementation(() => new Promise(() => {})); // never settles → times out
    const res = await request(app)
      .post('/api/tts')
      .send({ provider: 'edge', voice: 'v', text: 'Slow on-device synth.' });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/timed out/);
    expect(mocks.edgeSynthesize).toHaveBeenCalledTimes(1); // no second concurrent attempt
  });

  it('still retries non-timeout failures even when retryOnTimeout is off', async () => {
    mocks.edgeRetryOnTimeout = false;
    mocks.edgeSynthesize.mockRejectedValue(new Error('noise glitch'));
    const res = await request(app)
      .post('/api/tts')
      .send({ provider: 'edge', voice: 'v', text: 'Retry this one.' });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('noise glitch');
    expect(mocks.edgeSynthesize).toHaveBeenCalledTimes(2);
  });
});

describe('POST /api/tts synthesis queues', () => {
  const words = [{ text: 'Hi', startMs: 0, endMs: 200, charStart: 0, charEnd: 2 }];
  const ok = () => ({ audio: Buffer.from('AUDIO'), format: 'mp3', words });
  // a fresh app per test: each router builds its per-provider queues once
  const freshApp = () => createApp({ dataDir });

  it('gives each provider its own queue, so a slow provider never starves another', async () => {
    const local = freshApp();
    mocks.elevenAvailable.mockReturnValue(true);
    mocks.elevenTimeoutMs = 300;
    mocks.elevenSynthesize.mockImplementation(() => new Promise(() => {})); // stuck
    mocks.edgeSynthesize.mockResolvedValue(ok());
    const stuck = [1, 2].map((n) =>
      request(local)
        .post('/api/tts')
        .send({ provider: 'elevenlabs', voice: 'v', text: `Stuck ${n}.` })
        .then((r) => r), // supertest only sends once awaited
    );
    await vi.waitFor(() => expect(mocks.elevenSynthesize).toHaveBeenCalledTimes(2));
    const started = Date.now();
    const edge = await request(local)
      .post('/api/tts')
      .send({ provider: 'edge', voice: 'v', text: 'Not queued behind them.' });
    expect(edge.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(250); // did not wait for the 300 ms timeouts
    await Promise.all(stuck);
  });

  it('runs a provider no wider than its declared concurrency', async () => {
    mocks.edgeConcurrency = 1;
    const local = freshApp();
    let active = 0;
    let peak = 0;
    mocks.edgeSynthesize.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return ok();
    });
    const res = await Promise.all(
      [1, 2, 3].map((n) =>
        request(local).post('/api/tts').send({ provider: 'edge', voice: 'v', text: `One at a time ${n}.` }),
      ),
    );
    expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(peak).toBe(1);
  });

  it('answers as soon as the audio exists, before the cache write lands', async () => {
    let persisted = false;
    const slowCache = {
      get: vi.fn(async () => null),
      put: vi.fn(() => new Promise((r) => setTimeout(() => { persisted = true; r(); }, 400))),
    };
    const local = express().use(express.json()).use('/api/tts', ttsRouter({ cache: slowCache }));
    mocks.edgeSynthesize.mockResolvedValue(ok());
    const started = Date.now();
    const res = await request(local).post('/api/tts').send({ provider: 'edge', voice: 'v', text: 'Reply first.' });
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(false);
    expect(Date.now() - started).toBeLessThan(300);
    expect(persisted).toBe(false);
    expect(slowCache.put).toHaveBeenCalledTimes(1);
  });

  it('still returns the audio when writing the cache fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const brokenCache = { get: vi.fn(async () => null), put: vi.fn(async () => { throw new Error('disk full'); }) };
    const local = express().use(express.json()).use('/api/tts', ttsRouter({ cache: brokenCache }));
    mocks.edgeSynthesize.mockResolvedValue(ok());
    const res = await request(local).post('/api/tts').send({ provider: 'edge', voice: 'v', text: 'Disk is full.' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0][0])).toContain('disk full');
    warn.mockRestore();
  });

  it('never synthesizes a queued request whose client has gone away', async () => {
    mocks.edgeConcurrency = 1;
    const local = freshApp();
    const { providers } = await import('../../server/providers/index.js');
    let release;
    mocks.edgeSynthesize
      .mockImplementationOnce(() => new Promise((r) => { release = () => r(ok()); }))
      .mockResolvedValue(ok());
    const first = request(local).post('/api/tts').send({ provider: 'edge', voice: 'v', text: 'Holds the slot.' });
    const firstDone = first.then((r) => r);
    await vi.waitFor(() => expect(mocks.edgeSynthesize).toHaveBeenCalledTimes(1));
    const known = providers.edge.isKnownVoice.mock.calls.length;
    const second = request(local).post('/api/tts').send({ provider: 'edge', voice: 'v', text: 'Abandoned while queued.' });
    second.end(() => {}); // start it; the client is about to hang up
    await vi.waitFor(() => expect(providers.edge.isKnownVoice.mock.calls.length).toBe(known + 1));
    await new Promise((r) => setTimeout(r, 30)); // past the cache lookup, into the queue
    second.abort();
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect((await firstDone).status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));
    expect(mocks.edgeSynthesize).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/voices', () => {
  it('returns edge voices and elevenlabs availability', async () => {
    const res = await request(app).get('/api/voices');
    expect(res.status).toBe(200);
    expect(res.body.edge.voices.length).toBe(1);
    expect(res.body.edge.default).toBeTruthy();
    expect(res.body.elevenlabs).toMatchObject({ available: false, voices: [] });
    expect(res.body.supertonic).toMatchObject({ available: false, voices: [] });
    expect(mocks.edgeVoices).toHaveBeenCalledWith({ all: false });
  });

  it('exposes no kokoro voices until its assets are on disk', async () => {
    const res = await request(app).get('/api/voices');
    expect(res.status).toBe(200);
    expect(res.body.kokoro).toMatchObject({ available: false, voices: [] });
    expect(mocks.kokoroVoices).not.toHaveBeenCalled();
  });

  it('lists kokoro voices, with its default, once the assets are present', async () => {
    const heart = { id: 'af_heart', label: 'Kokoro Heart (en-US)', locale: 'en-US', gender: 'Female' };
    mocks.kokoroAvailable.mockReturnValue(true);
    mocks.kokoroVoices.mockReturnValue([heart]);
    const res = await request(app).get('/api/voices');
    expect(res.status).toBe(200);
    expect(res.body.kokoro).toEqual({ available: true, voices: [heart], default: 'af_heart' });
  });
});

describe('POST /api/docs/import/text', () => {
  it('extracts, segments and persists in one request', async () => {
    const res = await importText('Para one line.\n\nPara two here.');
    expect(res.status).toBe(201);
    const doc = res.body;
    expect(doc.id).toBeTruthy();
    expect(doc.title).toBe('Para one line.');
    expect(doc.blocks).toEqual([
      { type: 'p', text: 'Para one line.' },
      { type: 'p', text: 'Para two here.' },
    ]);
    expect(doc.sentences.length).toBe(2);
    expect(doc.chunks.length).toBeGreaterThanOrEqual(1);
    expect(doc.chunks[0].text).toBeTruthy();
    expect(doc.position).toEqual({ chunkIdx: 0, inChunkMs: 0 });
    await request(app).delete(`/api/docs/${doc.id}`);
  });

  it('rejects empty text', async () => {
    expect((await importText('  ')).status).toBe(400);
    expect((await request(app).post('/api/docs/import/text').send({})).status).toBe(400);
  });
});

describe('POST /api/docs/import/url (validation only — live fetch covered in integration)', () => {
  it('rejects malformed and non-http URLs', async () => {
    const post = (body) => request(app).post('/api/docs/import/url').send(body);
    expect((await post({ url: 'not a url' })).status).toBe(400);
    expect((await post({ url: 'ftp://example.com/x' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});

describe('POST /api/docs/import/pdf', () => {
  // These cover the text-layer path only; disable OCR so the blank-PDF case
  // throws fast instead of loading the canvas/tesseract stack (OCR has its own
  // live integration test).
  let prevOcr;
  beforeAll(() => {
    prevOcr = process.env.OCR_ENABLED;
    process.env.OCR_ENABLED = '0';
  });
  afterAll(() => {
    if (prevOcr === undefined) delete process.env.OCR_ENABLED;
    else process.env.OCR_ENABLED = prevOcr;
  });

  it('imports the fixture PDF as a saved doc with page provenance', async () => {
    const res = await request(app).post('/api/docs/import/pdf').attach('file', fixture('sample.pdf'));
    expect(res.status).toBe(201);
    const doc = res.body;
    expect(doc.title).toBe('sample');
    expect(doc.blocks.length).toBe(5);
    expect(doc.blocks.slice(1).map((b) => b.page)).toEqual([1, 1, 2, 2]);
    expect(doc.source).toEqual({ type: 'pdf', value: 'sample.pdf' });
    expect(doc.chunks.every((c) => typeof c.text === 'string' && c.text.length > 0)).toBe(true);
    await request(app).delete(`/api/docs/${doc.id}`);
  });

  it('returns 422 NO_TEXT_LAYER for scanned-style PDFs', async () => {
    const res = await request(app).post('/api/docs/import/pdf').attach('file', fixture('empty.pdf'));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NO_TEXT_LAYER');
  });

  it('returns 400 for non-PDF bytes and missing file', async () => {
    const bad = await request(app)
      .post('/api/docs/import/pdf')
      .attach('file', Buffer.from('plain text'), 'notes.pdf');
    expect(bad.status).toBe(400);
    expect((await request(app).post('/api/docs/import/pdf')).status).toBe(400);
  });
});

describe('document library & storage layout', () => {
  it('lists, gets, repositions (sidecar, not doc rewrite) and deletes', async () => {
    const created = await importText('First sentence here. Second sentence too.\n\nAnother paragraph of words.', 'Storage Doc');
    expect(created.status).toBe(201);
    const doc = created.body;

    // stored doc has no chunk text; GET hydrates it back identically
    const rawDoc = JSON.parse(await readFile(path.join(dataDir, 'docs', `${doc.id}.json`), 'utf8'));
    expect(rawDoc.chunks.every((c) => !('text' in c))).toBe(true);
    const fetched = await request(app).get(`/api/docs/${doc.id}`);
    expect(fetched.status).toBe(200);
    fetched.body.chunks.forEach((c) => {
      expect(c.text).toBe(fetched.body.blocks[c.block].text.slice(c.start, c.end));
    });

    // list uses the meta summary
    const list = await request(app).get('/api/docs');
    const entry = list.body.find((d) => d.id === doc.id);
    expect(entry).toMatchObject({ title: 'Storage Doc', chunkCount: doc.chunks.length });
    expect(entry.charCount).toBe(doc.blocks.reduce((n, b) => n + b.text.length, 0));
    expect(entry.position).toEqual({ chunkIdx: 0, inChunkMs: 0 });

    // PATCH position writes the sidecar and leaves the doc file untouched
    const docBytesBefore = await readFile(path.join(dataDir, 'docs', `${doc.id}.json`), 'utf8');
    const patched = await request(app)
      .patch(`/api/docs/${doc.id}/position`)
      .send({ chunkIdx: 1, inChunkMs: 1234.5 });
    expect(patched.status).toBe(200);
    expect(await readFile(path.join(dataDir, 'docs', `${doc.id}.json`), 'utf8')).toBe(docBytesBefore);
    const sidecar = JSON.parse(await readFile(path.join(dataDir, 'positions', `${doc.id}.json`), 'utf8'));
    expect(sidecar).toMatchObject({ chunkIdx: 1, inChunkMs: 1234.5 });
    expect((await request(app).get(`/api/docs/${doc.id}`)).body.position).toEqual({ chunkIdx: 1, inChunkMs: 1234.5 });
    expect((await request(app).get('/api/docs')).body.find((d) => d.id === doc.id).position.chunkIdx).toBe(1);

    // delete removes doc + sidecars
    expect((await request(app).delete(`/api/docs/${doc.id}`)).status).toBe(200);
    expect((await request(app).get(`/api/docs/${doc.id}`)).status).toBe(404);
    await expect(access(path.join(dataDir, 'positions', `${doc.id}.json`))).rejects.toThrow();
    await expect(access(path.join(dataDir, 'meta', `${doc.id}.json`))).rejects.toThrow();
  });

  it('self-heals legacy docs (embedded position, chunk text, no meta)', async () => {
    const legacy = {
      id: 'legacy-abc123',
      title: 'Legacy Doc',
      source: { type: 'text', value: null },
      savedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
      blocks: [{ type: 'p', text: 'Old style sentence. Another one.' }],
      sentences: [
        { block: 0, start: 0, end: 18 },
        { block: 0, start: 19, end: 32 },
      ],
      chunks: [{ idx: 0, block: 0, start: 0, end: 32, text: 'Old style sentence. Another one.', sentences: [0, 1] }],
      position: { chunkIdx: 0, inChunkMs: 777 },
    };
    await writeFile(path.join(dataDir, 'docs', 'legacy-abc123.json'), JSON.stringify(legacy));

    const list = await request(app).get('/api/docs');
    const entry = list.body.find((d) => d.id === 'legacy-abc123');
    expect(entry).toBeTruthy();
    expect(entry.charCount).toBe(32);
    expect(entry.position).toEqual({ chunkIdx: 0, inChunkMs: 777 });
    await access(path.join(dataDir, 'meta', 'legacy-abc123.json'));
    await access(path.join(dataDir, 'positions', 'legacy-abc123.json'));

    const doc = await request(app).get('/api/docs/legacy-abc123');
    expect(doc.body.chunks[0].text).toBe('Old style sentence. Another one.');
    expect(doc.body.position.inChunkMs).toBe(777);
    await request(app).delete('/api/docs/legacy-abc123');
  });

  it('validates position payloads and 404s for unknown ids', async () => {
    const created = await importText('Validate me please.');
    const id = created.body.id;
    expect(
      (await request(app).patch(`/api/docs/${id}/position`).send({ chunkIdx: -1, inChunkMs: 0 })).status,
    ).toBe(400);
    expect(
      (await request(app).patch(`/api/docs/${id}/position`).send({ chunkIdx: 0.5, inChunkMs: 0 })).status,
    ).toBe(400);
    await request(app).delete(`/api/docs/${id}`);

    expect((await request(app).get('/api/docs/zzzz-000000')).status).toBe(404);
    expect(
      (await request(app).patch('/api/docs/zzzz-000000/position').send({ chunkIdx: 0, inChunkMs: 0 })).status,
    ).toBe(404);
    expect((await request(app).delete('/api/docs/zzzz-000000')).status).toBe(404);
  });
});

describe('POST /api/segment', () => {
  it('segments caller-owned blocks without persisting', async () => {
    const blocks = [
      { type: 'h2', text: 'A heading here' },
      { type: 'p', text: 'First sentence of the body. Second sentence follows along.' },
    ];
    const res = await request(app).post('/api/segment').send({ blocks });
    expect(res.status).toBe(200);
    expect(res.body.sentences.length).toBe(3);
    expect(res.body.chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of res.body.chunks) {
      expect(blocks[c.block].text.slice(c.start, c.end)).toBe(c.text);
    }
    expect((await request(app).get('/api/docs')).body.some((d) => d.title === 'A heading here')).toBe(false);
  });

  it('rejects empty input and blocks with no text (index parity)', async () => {
    expect((await request(app).post('/api/segment').send({})).status).toBe(400);
    expect((await request(app).post('/api/segment').send({ blocks: [] })).status).toBe(400);
    const res = await request(app)
      .post('/api/segment')
      .send({ blocks: [{ type: 'p', text: 'Fine.' }, { type: 'p', text: '   ' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('block 1');
  });
});

describe('POST /api/docs/import/blocks', () => {
  it('persists pre-extracted blocks as a library doc', async () => {
    const res = await request(app).post('/api/docs/import/blocks').send({
      title: 'Gemini answer',
      source: { type: 'url', value: 'https://gemini.google.com/app' },
      blocks: [
        { type: 'p', text: 'Here is the answer to your question. It has two sentences.' },
        { type: 'weird', text: 'Coerced to paragraph.' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Gemini answer');
    expect(res.body.source).toEqual({ type: 'url', value: 'https://gemini.google.com/app' });
    expect(res.body.blocks[1].type).toBe('p');
    expect(res.body.chunks.length).toBeGreaterThanOrEqual(1);
    const list = await request(app).get('/api/docs');
    expect(list.body.some((d) => d.id === res.body.id)).toBe(true);
    await request(app).delete(`/api/docs/${res.body.id}`);
  });

  it('validates title and blocks', async () => {
    expect((await request(app).post('/api/docs/import/blocks').send({ blocks: [{ text: 'x' }] })).status).toBe(400);
    expect((await request(app).post('/api/docs/import/blocks').send({ title: 'T' })).status).toBe(400);
    expect(
      (await request(app).post('/api/docs/import/blocks').send({ title: 'T', blocks: [{ text: ' ' }] })).status,
    ).toBe(400);
  });
});

describe('API fallthrough', () => {
  it('404s unknown API paths with JSON', async () => {
    const res = await request(app).get('/api/definitely-not-real');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('front-gate: Host/Origin allowlist + security headers', () => {
  it('rejects a non-loopback Host (DNS rebinding) on read and delete', async () => {
    expect((await request(app).get('/api/docs').set('Host', 'evil.attacker.com')).status).toBe(403);
    expect((await request(app).delete('/api/docs/anything').set('Host', 'evil.test:3000')).status).toBe(403);
  });

  it('allows the loopback Host and sets security headers', async () => {
    const res = await request(app).get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('rejects a cross-origin Origin on a write but allows the extension origin', async () => {
    const blocked = await request(app)
      .post('/api/docs/import/text')
      .set('Origin', 'http://evil.test')
      .send({ text: 'Cross origin attempt.' });
    expect(blocked.status).toBe(403);

    const ok = await request(app)
      .post('/api/docs/import/text')
      .set('Origin', 'chrome-extension://mmchihfpfdagbgkmlccclgepjjhdcbfe')
      .send({ text: 'Trusted extension import. It has two sentences.' });
    expect(ok.status).toBe(201);
    await request(app).delete(`/api/docs/${ok.body.id}`);
  });
});

describe('structural caps on heavy routes', () => {
  it('413s a segment payload with too many blocks', async () => {
    const blocks = Array.from({ length: 5001 }, () => ({ type: 'p', text: 'x' }));
    expect((await request(app).post('/api/segment').send({ blocks })).status).toBe(413);
  });

  it('413s an oversized text import', async () => {
    const res = await request(app).post('/api/docs/import/text').send({ text: 'x'.repeat(2_000_001) });
    expect(res.status).toBe(413);
  });
});

describe('structural caps on server-built documents', () => {
  // saveExtracted is the single gate for all four import routes. /import/url and
  // /import/pdf build their blocks server-side, so no body cap and no
  // client-side limit bounds them — every case here answered 201 before.
  it('413s a PDF that expands past the per-block cap', async () => {
    // ~72 KB on the wire → one 60k-char stitched block (pages that never end on
    // terminal punctuation merge). A real FlateDecode'd PDF reaches millions of
    // characters from a quarter of a megabyte.
    const page = Array.from({ length: 55 }, (_, i) => `filler line ${i} ${'y'.repeat(80)}`);
    const res = await request(app)
      .post('/api/docs/import/pdf')
      .attach('file', pdfWithPages(Array.from({ length: 12 }, () => page)), 'expand.pdf');
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/block exceeds/);
    expect((await request(app).get('/api/docs')).body.some((d) => d.title === 'expand')).toBe(false);
  });

  it('413s a pasted paragraph that is under the text cap but over the block cap', async () => {
    const res = await importText('x'.repeat(60_000));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/block exceeds/);
  });

  it('413s an over-limit /import/blocks payload', async () => {
    const res = await request(app)
      .post('/api/docs/import/blocks')
      .send({ title: 'Too much', blocks: Array.from({ length: 5001 }, () => ({ type: 'p', text: 'x' })) });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too many blocks/);
  });
});

describe('POST /api/docs/import/blocks — caller-supplied title and source', () => {
  const save = (body) =>
    request(app)
      .post('/api/docs/import/blocks')
      .send({ blocks: [{ type: 'p', text: 'A saved answer. It has two sentences.' }], ...body });

  it('whitelists source.type, keeping the kinds the clients render', async () => {
    const bogus = await save({ title: 'Bogus source', source: { type: 'gopher', value: 'x' } });
    expect(bogus.status).toBe(201);
    expect(bogus.body.source).toEqual({ type: 'text', value: 'x' });

    const known = await save({ title: 'Known source', source: { type: 'url', value: 'https://example.com/a' } });
    expect(known.body.source).toEqual({ type: 'url', value: 'https://example.com/a' });

    await request(app).delete(`/api/docs/${bogus.body.id}`);
    await request(app).delete(`/api/docs/${known.body.id}`);
  });

  it('truncates an over-long title in the doc and in the library summary', async () => {
    const res = await save({ title: 'T'.repeat(5_000) });
    expect(res.status).toBe(201);
    expect(res.body.title.length).toBe(300);

    const entry = (await request(app).get('/api/docs')).body.find((d) => d.id === res.body.id);
    expect(entry.title.length).toBe(300);
    await request(app).delete(`/api/docs/${res.body.id}`);
  });
});
