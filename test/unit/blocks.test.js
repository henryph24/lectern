import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { htmlToBlocks, normalizeWhitespace } from '../../server/lib/extract/blocks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureHtml = readFileSync(path.join(here, '..', 'fixtures', 'article.html'), 'utf8');

function extractFixtureBlocks() {
  const dom = new JSDOM(fixtureHtml, { url: 'https://example.com/article' });
  const article = new Readability(dom.window.document).parse();
  expect(article?.content).toBeTruthy();
  return { article, blocks: htmlToBlocks(article.content) };
}

describe('htmlToBlocks on the fixture article (via Readability)', () => {
  it('produces typed blocks in document order with no empties', () => {
    const { blocks } = extractFixtureBlocks();
    expect(blocks.length).toBeGreaterThanOrEqual(8);
    for (const b of blocks) {
      expect(['h1', 'h2', 'h3', 'p', 'li', 'blockquote']).toContain(b.type);
      expect(b.text.trim().length).toBeGreaterThan(0);
    }
    const types = blocks.map((b) => b.type);
    expect(types).toContain('h2');
    expect(types).toContain('li');
    expect(types).toContain('blockquote');
  });

  it('keeps real article content', () => {
    const { blocks } = extractFixtureBlocks();
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).toContain('Audiobooks were once a niche product');
    expect(all).toContain('Synchronized highlighting improves recall');
    expect(all).toContain('working memory');
  });

  it('drops navigation, footer, forms and figure captions', () => {
    const { blocks } = extractFixtureBlocks();
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).not.toContain('Subscribe');
    expect(all).not.toContain('All rights reserved');
    expect(all).not.toContain('analytics nonsense');
    expect(all).not.toContain('waveform rendering');
  });

  it('collapses internal whitespace', () => {
    const blocks = htmlToBlocks('<p>Spaced\n   out\t text</p>');
    expect(blocks).toEqual([{ type: 'p', text: 'Spaced out text' }]);
  });

  it('handles nested lists without duplicating text', () => {
    const blocks = htmlToBlocks('<ul><li>Outer item<ul><li>Inner item</li></ul></li></ul>');
    expect(blocks).toEqual([
      { type: 'li', text: 'Outer item' },
      { type: 'li', text: 'Inner item' },
    ]);
  });
});

describe('normalizeWhitespace', () => {
  it('trims and collapses all whitespace runs', () => {
    expect(normalizeWhitespace('  a \n\t b  ')).toBe('a b');
    expect(normalizeWhitespace('\n \t')).toBe('');
  });
});
