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

describe('citation markers', () => {
  it('drops reference superscripts so "[1][2]" is never read aloud', () => {
    const blocks = htmlToBlocks(
      '<p>Turing was born in 1912.<sup class="reference"><a href="#cite_note-1">[1]</a></sup>' +
        '<sup class="reference"><a href="#cite_note-2">[2]</a></sup> He studied at King\'s.</p>',
    );
    expect(blocks).toEqual([{ type: 'p', text: "Turing was born in 1912. He studied at King's." }]);
  });

  it('drops a [citation needed] superscript, whose link leaves the page', () => {
    const blocks = htmlToBlocks(
      '<p>A bold claim.<sup class="noprint"><i>[<a href="/wiki/Wikipedia:Citation_needed">' +
        'citation needed</a>]</i></sup> More text.</p>',
    );
    expect(blocks).toEqual([{ type: 'p', text: 'A bold claim. More text.' }]);
  });

  it('keeps superscripts without a link (exponents, ordinals)', () => {
    const blocks = htmlToBlocks('<p>E = mc<sup>2</sup> held on the 1<sup>st</sup> try.</p>');
    expect(blocks).toEqual([{ type: 'p', text: 'E = mc2 held on the 1st try.' }]);
  });

  it('drops markers inside headings, list items and blockquotes', () => {
    const blocks = htmlToBlocks(
      '<h2>History<sup><a href="#note-a">a</a></sup></h2>' +
        '<ul><li>First item.<sup><a href="#fn1">1</a></sup></li></ul>' +
        '<blockquote><p>Quoted line.<sup><a href="#fn2">2</a></sup></p></blockquote>',
    );
    expect(blocks).toEqual([
      { type: 'h2', text: 'History' },
      { type: 'li', text: 'First item.' },
      { type: 'blockquote', text: 'Quoted line.' },
    ]);
  });

  it('drops markers that survive Readability on a real article shape', () => {
    const para = (n) =>
      `<p>Paragraph ${n} explains the machine in plain words, with enough detail to count as prose` +
      `.<sup id="cite_ref-${n}" class="reference"><a href="#cite_note-${n}">[${n}]</a></sup> ` +
      'It continues with a second sentence so the extractor keeps it.</p>';
    const html = `<!DOCTYPE html><html><head><title>Machine</title></head><body><article>
      <h1>Machine</h1>${[1, 2, 3, 4, 5, 6].map(para).join('')}</article></body></html>`;
    const dom = new JSDOM(html, { url: 'https://en.wikipedia.org/wiki/Machine' });
    const article = new Readability(dom.window.document).parse();
    const text = htmlToBlocks(article.content).map((b) => b.text).join(' ');
    expect(text).toContain('Paragraph 3 explains the machine');
    expect(text).not.toMatch(/\[\d+\]/);
  });
});
