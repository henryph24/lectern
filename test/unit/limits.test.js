import { describe, it, expect } from 'vitest';
import {
  blocksOverLimit,
  clampTitle,
  normalizeSource,
  textOverLimit,
  MAX_BLOCKS,
  MAX_BLOCK_CHARS,
  MAX_TITLE_CHARS,
  MAX_TOTAL_CHARS,
} from '../../server/lib/limits.js';

describe('blocksOverLimit', () => {
  it('passes normal and empty documents', () => {
    expect(blocksOverLimit([{ type: 'p', text: 'Hello world.' }])).toBeNull();
    expect(blocksOverLimit([])).toBeNull();
  });

  it('rejects too many blocks', () => {
    const many = Array.from({ length: MAX_BLOCKS + 1 }, () => ({ type: 'p', text: 'x' }));
    expect(blocksOverLimit(many)).toMatch(/too many blocks/);
  });

  it('rejects an oversized single block', () => {
    expect(blocksOverLimit([{ type: 'p', text: 'x'.repeat(MAX_BLOCK_CHARS + 1) }])).toMatch(/exceeds/);
  });

  it('rejects an oversized total across blocks', () => {
    const each = { type: 'p', text: 'x'.repeat(MAX_BLOCK_CHARS) };
    const count = Math.ceil(MAX_TOTAL_CHARS / MAX_BLOCK_CHARS) + 1;
    const blocks = Array.from({ length: count }, () => each);
    expect(blocksOverLimit(blocks)).toMatch(/document exceeds/);
  });
});

describe('textOverLimit', () => {
  it('passes normal text and rejects huge text', () => {
    expect(textOverLimit('short enough')).toBeNull();
    expect(textOverLimit('x'.repeat(MAX_TOTAL_CHARS + 1))).toMatch(/exceeds/);
  });
});

describe('clampTitle', () => {
  it('trims and passes through a normal title', () => {
    expect(clampTitle('  A Perfectly Ordinary Headline  ')).toBe('A Perfectly Ordinary Headline');
  });

  it('truncates an over-long title to the cap', () => {
    const clamped = clampTitle('x'.repeat(MAX_TITLE_CHARS + 5_000));
    expect(clamped.length).toBe(MAX_TITLE_CHARS);
    expect(clamped.endsWith('\u2026')).toBe(true);
  });

  it('leaves non-strings alone for the routes to reject', () => {
    expect(clampTitle(undefined)).toBeUndefined();
    expect(clampTitle(null)).toBeNull();
  });
});

describe('normalizeSource', () => {
  it('keeps the types the clients render', () => {
    expect(normalizeSource({ type: 'url', value: 'https://example.com/a' })).toEqual({
      type: 'url',
      value: 'https://example.com/a',
    });
    expect(normalizeSource({ type: 'pdf', value: 'paper.pdf' })).toEqual({
      type: 'pdf',
      value: 'paper.pdf',
    });
  });

  it('coerces an unknown, absent or non-string type to text', () => {
    expect(normalizeSource({ type: 'javascript:alert(1)', value: 'x' })).toEqual({
      type: 'text',
      value: 'x',
    });
    expect(normalizeSource({ type: { toString: () => 'url' } })).toEqual({ type: 'text', value: null });
    expect(normalizeSource(undefined)).toEqual({ type: 'text', value: null });
    expect(normalizeSource('url')).toEqual({ type: 'text', value: null });
  });

  it('nulls a non-string value', () => {
    expect(normalizeSource({ type: 'url', value: { href: 'x' } })).toEqual({ type: 'url', value: null });
  });
});
