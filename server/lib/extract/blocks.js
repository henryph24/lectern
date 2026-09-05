import { JSDOM } from 'jsdom';

const BLOCK_TAGS = new Map([
  ['H1', 'h1'],
  ['H2', 'h2'],
  ['H3', 'h3'],
  ['H4', 'h3'],
  ['H5', 'h3'],
  ['H6', 'h3'],
  ['P', 'p'],
  ['PRE', 'p'],
  ['LI', 'li'],
  ['BLOCKQUOTE', 'blockquote'],
]);

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
  'FORM', 'BUTTON', 'NAV', 'ASIDE', 'FOOTER', 'HEADER', 'FIGURE', 'FIGCAPTION', 'TABLE',
]);

export function htmlToBlocks(html) {
  const dom = new JSDOM(html);
  const blocks = [];
  walk(dom.window.document.body, blocks);
  return blocks;
}

function walk(node, blocks) {
  for (const child of node.children) {
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) continue;

    if (tag === 'LI') {
      const clone = child.cloneNode(true);
      for (const nested of clone.querySelectorAll('ul, ol')) nested.remove();
      push(blocks, 'li', clone.textContent);
      for (const nested of child.querySelectorAll(':scope > ul, :scope > ol')) {
        walk(nested, blocks);
      }
      continue;
    }

    if (tag === 'BLOCKQUOTE') {
      const inner = child.querySelectorAll('p, li');
      if (inner.length > 0) {
        for (const el of inner) push(blocks, 'blockquote', el.textContent);
      } else {
        push(blocks, 'blockquote', child.textContent);
      }
      continue;
    }

    const type = BLOCK_TAGS.get(tag);
    if (type) {
      push(blocks, type, child.textContent);
    } else {
      walk(child, blocks);
    }
  }
}

function push(blocks, type, raw) {
  const text = normalizeWhitespace(raw ?? '');
  if (text) blocks.push({ type, text });
}

// Bidi overrides and zero-width characters: U+200B-200F, U+202A-202E,
// U+2066-2069, U+FEFF. A title like "Invoice \u202Egnp.exe\u202C receipt" renders
// reversed in the library and in the player bar, and for a read-aloud app the
// screen and the audio then disagree — hidden or reordered text is spoken while
// something else is displayed. This is normalization, not parsing.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function normalizeWhitespace(s) {
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}
