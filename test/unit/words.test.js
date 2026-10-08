import { describe, it, expect } from 'vitest';
import { edgeBoundariesToWords, elevenAlignmentToWords, durationToWords, spansToWords } from '../../server/lib/words.js';

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

describe('spansToWords (Kokoro span timing)', () => {
  // Spans tile the text the way the G2P splits it: one whitespace-delimited
  // token plus its trailing whitespace each, timed by the speech it produced.
  const span = (from, to, startMs, endMs) => ({ charStart: from, charEnd: to, startMs, endMs });

  it('times each word from its span and keeps exact char offsets', () => {
    const text = 'Hello, world. Bye';
    const words = spansToWords(text, [
      span(0, 7, 120, 480), // "Hello, "
      span(7, 14, 610, 950), // "world. "
      span(14, 17, 1400, 1700), // "Bye"
    ]);
    expect(words).toEqual([
      { text: 'Hello', startMs: 120, endMs: 480, charStart: 0, charEnd: 5 },
      { text: 'world', startMs: 610, endMs: 950, charStart: 7, charEnd: 12 },
      { text: 'Bye', startMs: 1400, endMs: 1700, charStart: 14, charEnd: 17 },
    ]);
    for (const w of words) expect(text.slice(w.charStart, w.charEnd)).toBe(w.text);
  });

  it('shares one span among the words inside it, in proportion to their char offsets', () => {
    const text = 'well-known fact'; // "well-known " is one G2P token, two segmenter words
    const words = spansToWords(text, [span(0, 11, 1000, 2000), span(11, 15, 2100, 2500)]);
    expect(words.map((w) => w.text)).toEqual(['well', 'known', 'fact']);
    // "well" covers chars 0-4 of the 0-10 word range, "known" chars 5-10
    expect(words[0]).toMatchObject({ startMs: 1000, endMs: 1400, charStart: 0, charEnd: 4 });
    expect(words[1]).toMatchObject({ startMs: 1500, endMs: 2000, charStart: 5, charEnd: 10 });
    for (let i = 1; i < words.length; i++) expect(words[i].startMs).toBeGreaterThanOrEqual(words[i - 1].endMs);
  });

  it('drops words whose span produced no speech', () => {
    const text = 'Hi 日本 there';
    const words = spansToWords(text, [
      span(0, 3, 100, 300),
      span(3, 6, null, null), // the G2P has no phonemes for these characters
      span(6, 11, 400, 800),
    ]);
    expect(words.map((w) => w.text)).toEqual(['Hi', 'there']);
    expect(words[1]).toMatchObject({ charStart: 6, charEnd: 11, startMs: 400 });
  });

  it('marks speech that matches no word-like segment with charStart -1, in time order', () => {
    const text = 'Go — now';
    const words = spansToWords(text, [
      span(0, 3, 0, 200),
      span(3, 5, 250, 400), // "— " spoken with no word-like segment
      span(5, 8, 450, 700),
    ]);
    expect(words).toEqual([
      { text: 'Go', startMs: 0, endMs: 200, charStart: 0, charEnd: 2 },
      { text: '—', startMs: 250, endMs: 400, charStart: -1, charEnd: -1 },
      { text: 'now', startMs: 450, endMs: 700, charStart: 5, charEnd: 8 },
    ]);
  });

  it('rounds to whole milliseconds and stays monotonic', () => {
    const text = 'one two three';
    const words = spansToWords(text, [
      span(0, 4, 10.4, 200.6),
      span(4, 8, 200.6, 399.5),
      span(8, 13, 399.5, 612.2),
    ]);
    expect(words.map((w) => [w.startMs, w.endMs])).toEqual([
      [10, 201],
      [201, 400],
      [400, 612],
    ]);
  });

  it('returns [] for empty input', () => {
    expect(spansToWords('', [])).toEqual([]);
  });
});
