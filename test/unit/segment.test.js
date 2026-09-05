import { describe, it, expect } from 'vitest';
import { segmentDocument, splitSentences, LIMITS } from '../../server/lib/segment.js';

describe('splitSentences', () => {
  it('returns trimmed sentence ranges with exact offsets', () => {
    const text = 'Hello world. Second sentence here! Third?';
    const s = splitSentences(text);
    expect(s.length).toBe(3);
    expect(text.slice(s[0].start, s[0].end)).toBe('Hello world.');
    expect(text.slice(s[1].start, s[1].end)).toBe('Second sentence here!');
    expect(text.slice(s[2].start, s[2].end)).toBe('Third?');
  });

  it('returns nothing for whitespace-only text', () => {
    expect(splitSentences('   \n  ')).toEqual([]);
  });
});

describe('segmentDocument', () => {
  it('packs sentences greedily without crossing block boundaries', () => {
    const blocks = [
      { type: 'p', text: 'One. Two. Three.' },
      { type: 'p', text: 'Separate block. Also here.' },
    ];
    const { sentences, chunks } = segmentDocument(blocks);
    expect(sentences.length).toBe(5);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toMatchObject({ block: 0, text: 'One. Two. Three.', sentences: [0, 2] });
    expect(chunks[1]).toMatchObject({ block: 1, text: 'Separate block. Also here.', sentences: [3, 4] });
  });

  it('absorbs abbreviation over-splits ("Dr.") into one chunk', () => {
    const blocks = [{ type: 'p', text: 'Dr. Lindqvist agrees with the finding. The rest follows.' }];
    const { chunks } = segmentDocument(blocks);
    expect(chunks[0].text.startsWith('Dr. Lindqvist agrees')).toBe(true);
  });

  it('starts a new chunk when the soft limit would be exceeded', () => {
    const sentence = `${'Word '.repeat(39)}end.`;
    const blocks = [{ type: 'p', text: `${sentence} ${sentence}` }];
    const { chunks } = segmentDocument(blocks);
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(LIMITS.SOFT_LIMIT);
    }
  });

  it('splits a single sentence beyond the hard limit at word boundaries, tiling exactly', () => {
    const long = `${'reallylongword '.repeat(120)}done.`;
    const blocks = [{ type: 'p', text: long }];
    const { sentences, chunks } = segmentDocument(blocks);
    expect(sentences.length).toBe(1);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.sentences).toEqual([0, 0]);
      expect(c.text.length).toBeLessThanOrEqual(LIMITS.SOFT_LIMIT + 20);
    }
    expect(chunks.map((c) => c.text).join('')).toBe(long);
  });

  it('chunk char ranges map exactly onto block text', () => {
    const blocks = [
      { type: 'h2', text: 'A heading' },
      { type: 'p', text: 'Alpha beta. Gamma delta. Epsilon zeta.' },
    ];
    const { chunks } = segmentDocument(blocks);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(blocks[c.block].text.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it('ramps the leading chunks smaller, then settles at the soft limit', () => {
    const [first, second] = LIMITS.FIRST_CHUNK_LIMITS;
    // 40 short (20-char) sentences in one block exercises all three ramp tiers.
    const blocks = [{ type: 'p', text: Array(40).fill('Short sentence here.').join(' ') }];
    const { sentences, chunks } = segmentDocument(blocks);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].text.length).toBeLessThanOrEqual(first);
    expect(chunks[1].text.length).toBeLessThanOrEqual(second);
    // the ramp widened: chunk 1 packed past what chunk 0's cap allowed
    expect(chunks[1].text.length).toBeGreaterThan(first);
    for (let k = 2; k < chunks.length; k++) {
      expect(chunks[k].text.length).toBeLessThanOrEqual(LIMITS.SOFT_LIMIT);
    }

    // invariants unchanged: text slices map onto the block and sentences tile in order
    let next = 0;
    for (const c of chunks) {
      expect(blocks[c.block].text.slice(c.start, c.end)).toBe(c.text);
      expect(c.sentences[0]).toBe(next);
      next = c.sentences[1] + 1;
    }
    expect(next).toBe(sentences.length);
  });

  it('chunk sentence ranges tile the sentence list in order', () => {
    const blocks = [
      { type: 'p', text: `${'Short one. '.repeat(40)}` },
      { type: 'p', text: 'Tail block here.' },
    ];
    const { sentences, chunks } = segmentDocument(blocks);
    let next = 0;
    for (const c of chunks) {
      expect(c.sentences[0]).toBe(next);
      expect(c.sentences[1]).toBeGreaterThanOrEqual(c.sentences[0]);
      next = c.sentences[1] + 1;
    }
    expect(next).toBe(sentences.length);
  });
});
