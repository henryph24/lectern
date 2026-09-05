import { describe, it, expect } from 'vitest';
import { edgeBoundariesToWords, elevenAlignmentToWords, durationToWords } from '../../server/lib/words.js';

describe('edgeBoundariesToWords', () => {
  it('maps punctuation-stripped boundary words to exact char ranges', () => {
    const text = 'Hello, world. "Quote" here.';
    const boundaries = [
      { text: 'Hello', startMs: 0, endMs: 300 },
      { text: 'world', startMs: 350, endMs: 700 },
      { text: 'Quote', startMs: 750, endMs: 1000 },
      { text: 'here', startMs: 1050, endMs: 1300 },
    ];
    const words = edgeBoundariesToWords(boundaries, text);
    expect(words[0]).toMatchObject({ charStart: 0, charEnd: 5, startMs: 0, endMs: 300 });
    expect(text.slice(words[1].charStart, words[1].charEnd)).toBe('world');
    expect(text.slice(words[2].charStart, words[2].charEnd)).toBe('Quote');
    expect(text.slice(words[3].charStart, words[3].charEnd)).toBe('here');
  });

  it('anchors duplicate words to successive occurrences', () => {
    const text = 'the cat and the hat';
    const boundaries = ['the', 'cat', 'and', 'the', 'hat'].map((w, i) => ({
      text: w,
      startMs: i * 100,
      endMs: i * 100 + 90,
    }));
    const words = edgeBoundariesToWords(boundaries, text);
    expect(words[0].charStart).toBe(0);
    expect(words[3].charStart).toBe(12);
  });

  it('marks unmatched (spoken-form) words with charStart -1 without derailing later words', () => {
    const text = 'Costs rose to 12 dollars.';
    const boundaries = [
      { text: 'Costs', startMs: 0, endMs: 100 },
      { text: 'twelve', startMs: 200, endMs: 300 },
      { text: 'dollars', startMs: 400, endMs: 500 },
    ];
    const words = edgeBoundariesToWords(boundaries, text);
    expect(words[1]).toMatchObject({ charStart: -1, charEnd: -1, startMs: 200 });
    expect(text.slice(words[2].charStart, words[2].charEnd)).toBe('dollars');
  });

  it('handles empty boundary lists', () => {
    expect(edgeBoundariesToWords([], 'anything')).toEqual([]);
  });
});

describe('elevenAlignmentToWords', () => {
  it('aggregates character alignment into word timings with chunk-relative offsets', () => {
    const text = "It's 42 now.";
    const characters = [...text];
    const alignment = {
      characters,
      characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
      characterEndTimesSeconds: characters.map((_, i) => i * 0.1 + 0.1),
    };
    const words = elevenAlignmentToWords(alignment);
    expect(words.map((w) => w.text)).toEqual(["It's", '42', 'now']);
    expect(words[0]).toMatchObject({ charStart: 0, charEnd: 4, startMs: 0, endMs: 400 });
    expect(words[1]).toMatchObject({ charStart: 5, charEnd: 7, startMs: 500, endMs: 700 });
    expect(words[2].charEnd).toBe(11);
  });

  it('skips punctuation-only segments', () => {
    const text = 'Hi — there.';
    const characters = [...text];
    const alignment = {
      characters,
      characterStartTimesSeconds: characters.map((_, i) => i * 0.05),
      characterEndTimesSeconds: characters.map((_, i) => i * 0.05 + 0.05),
    };
    const words = elevenAlignmentToWords(alignment);
    expect(words.map((w) => w.text)).toEqual(['Hi', 'there']);
  });
});

describe('durationToWords (Supertonic proportional timing)', () => {
  it('maps words to exact char offsets and proportional, monotonic times', () => {
    const text = 'Hello world today.'; // length 18
    const words = durationToWords(text, 1.8); // 1800ms → 100ms per char
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world', 'today']);
    // each word's char range is exact, and time = (charOffset/len)*totalMs
    for (const w of words) expect(text.slice(w.charStart, w.charEnd)).toBe(w.text);
    expect(words[0]).toMatchObject({ charStart: 0, charEnd: 5, startMs: 0, endMs: 500 });
    expect(words[1]).toMatchObject({ charStart: 6, charEnd: 11, startMs: 600, endMs: 1100 });
    expect(words[2]).toMatchObject({ charStart: 12, charEnd: 17, startMs: 1200, endMs: 1700 });
    for (let i = 1; i < words.length; i++) {
      expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].endMs - 1);
    }
  });

  it('returns [] for empty text or non-positive duration', () => {
    expect(durationToWords('', 5)).toEqual([]);
    expect(durationToWords('   ', 5)).toEqual([]);
    expect(durationToWords('hello', 0)).toEqual([]);
    expect(durationToWords('hello', -1)).toEqual([]);
  });

  it('never exceeds the total duration', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const totalMs = 3000;
    const words = durationToWords(text, totalMs / 1000);
    expect(words.at(-1).endMs).toBeLessThanOrEqual(totalMs);
  });
});
