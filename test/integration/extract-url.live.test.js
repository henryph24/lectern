import { describe, it, expect } from 'vitest';
import { extractFromUrl } from '../../server/lib/extract/url.js';

describe('URL extraction — live fetch', () => {
  it('extracts a structured article from Wikipedia', async () => {
    const result = await extractFromUrl('https://en.wikipedia.org/wiki/Speech_synthesis');
    expect(result.title.toLowerCase()).toContain('speech');
    expect(result.blocks.length).toBeGreaterThan(10);
    expect(result.blocks[0].type).toBe('h1');
    expect(result.blocks.some((b) => b.type === 'h2' || b.type === 'h3')).toBe(true);
    const all = result.blocks.map((b) => b.text).join(' ').toLowerCase();
    expect(all).toContain('text');
    for (const b of result.blocks) expect(b.text.trim().length).toBeGreaterThan(0);
    // the article carries 100+ citation superscripts; none may reach the prose
    const prose = result.blocks.filter((b) => b.type === 'p').map((b) => b.text).join(' ');
    expect(prose).not.toMatch(/\[\d+\]/);
  });
});
