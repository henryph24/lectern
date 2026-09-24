import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cacheKey, createCache } from '../../server/lib/cache.js';

describe('cacheKey', () => {
  it('is deterministic', () => {
    expect(cacheKey('edge', 'voice-a', 'hello')).toBe(cacheKey('edge', 'voice-a', 'hello'));
  });

  it('varies across provider, voice and text', () => {
    const base = cacheKey('edge', 'voice-a', 'hello');
    expect(cacheKey('elevenlabs', 'voice-a', 'hello')).not.toBe(base);
    expect(cacheKey('edge', 'voice-b', 'hello')).not.toBe(base);
    expect(cacheKey('edge', 'voice-a', 'hello!')).not.toBe(base);
  });

  it('is immune to delimiter collisions between fields', () => {
    expect(cacheKey('e', 'v', 'a|b')).not.toBe(cacheKey('e', 'v|a', 'b'));
  });
});

describe('createCache', () => {
  let dir;
  let cache;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tts-cache-'));
    cache = createCache(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null on a miss', async () => {
    expect(await cache.get('0'.repeat(64))).toBeNull();
  });

  it('round-trips audio bytes and word timings', async () => {
    const key = cacheKey('edge', 'v', 'hi');
    const words = [{ text: 'hi', startMs: 0, endMs: 200, charStart: 0, charEnd: 2 }];
    await cache.put(key, { audio: Buffer.from([0xff, 0xf3, 0x01, 0x02]), format: 'mp3', words });
    const hit = await cache.get(key);
    expect(hit).not.toBeNull();
    expect([...hit.audio]).toEqual([0xff, 0xf3, 0x01, 0x02]);
    expect(hit.format).toBe('mp3');
    expect(hit.words).toEqual(words);
  });

  it('serves an entry from memory while its files are still being written', async () => {
    const key = 'b'.repeat(64);
    const entry = { audio: Buffer.from('MID-WRITE'), format: 'mp3', words: [] };
    const writing = cache.put(key, entry);
    const early = await cache.get(key); // the route answers before put() settles
    expect(early.audio.toString()).toBe('MID-WRITE');
    await writing;
    const late = await cache.get(key);
    expect(late.audio.toString()).toBe('MID-WRITE');
  });
});
