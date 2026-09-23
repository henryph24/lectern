import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { segmentDocument } from '../../server/lib/segment.js';
import { blocksOverLimit, MAX_BLOCK_CHARS } from '../../server/lib/limits.js';
import '../../extension/content/extract-core.js';

const core = globalThis.__lecternCore;
const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

const PAGE = `<!DOCTYPE html><html><body>
  <nav><ul><li>Home</li><li>About</li></ul></nav>
  <article>
    <h1>The   Title${"\u200B"}Here</h1>
    <p id="p1">First sentence with a <strong>bold</strong>word inside. Second
      sentence spans
      lines.</p>
    <div style="display:none">Invisible text that must never be read.</div>
    <div aria-hidden="true">Screen-reader hidden junk.</div>
    <div role="navigation"><ul><li>Recent chat one</li><li>Recent chat two</li></ul></div>
    <custom-banner role="banner">SPA app bar junk.</custom-banner>
    <p id="p2">Para two starts here. It keeps<br>going after a break.</p>
    <ul><li>Item one text.</li><li>Item two text.</li></ul>
    <div contenteditable="true">Type your reply here…</div>
    <div id="plain">Bare div text. Counts as a paragraph.</div>
  </article>
  <footer>Copyright footer junk.</footer>
</body></html>`;

let dom;
let doc;
let win;
let blocks;

beforeAll(() => {
  dom = new JSDOM(PAGE);
  doc = dom.window.document;
  win = dom.window;
  blocks = core.collectBlocks(core.pickRoot(doc), win);
});

describe('collectBlocks', () => {
  it('picks the article root and skips nav/footer/hidden/editable content', () => {
    const all = blocks.map((b) => b.text).join(' | ');
    expect(all).not.toContain('Home');
    expect(all).not.toContain('Copyright');
    expect(all).not.toContain('Invisible');
    expect(all).not.toContain('hidden junk');
    expect(all).not.toContain('Type your reply');
  });

  it('skips ARIA landmark chrome (role=navigation/banner) like its tag twins', () => {
    const all = blocks.map((b) => b.text).join(' | ');
    expect(all).not.toContain('Recent chat');
    expect(all).not.toContain('app bar junk');
  });

  it('normalizes whitespace (NBSP, newlines, runs, zero-width) and joins inline elements', () => {
    expect(blocks[0]).toMatchObject({ type: 'h1', text: 'The Title Here' });
    const p1 = blocks[1];
    expect(p1.text).toBe('First sentence with a boldword inside. Second sentence spans lines.');
    const p2 = blocks.find((b) => b.text.startsWith('Para two'));
    expect(p2.text).toBe('Para two starts here. It keeps going after a break.');
  });

  it('emits list items and bare-div text as typed blocks', () => {
    const types = blocks.map((b) => b.type);
    expect(blocks.filter((b) => b.type === 'li').map((b) => b.text)).toEqual([
      'Item one text.',
      'Item two text.',
    ]);
    expect(blocks.at(-1)).toMatchObject({ type: 'p', text: 'Bare div text. Counts as a paragraph.' });
    expect(types[0]).toBe('h1');
  });

  it('records segments that tile each block text exactly (spaces excluded)', () => {
    for (const block of blocks) {
      let covered = 0;
      let prevEnd = -1;
      for (const seg of block.segments) {
        expect(seg.normStart).toBeGreaterThan(prevEnd === -1 ? -1 : prevEnd - 1);
        expect(block.text.slice(seg.normStart, seg.normStart + seg.len)).toBe(
          seg.node.data.slice(seg.nodeStart, seg.nodeStart + seg.len),
        );
        covered += seg.len;
        prevEnd = seg.normStart + seg.len;
      }
      const nonSpace = block.text.split(' ').join('').length;
      expect(covered).toBe(nonSpace);
    }
  });
});

describe('round trip: DOM → blocks → segmentDocument → word offsets → Range', () => {
  it('maps every word of every chunk back to a Range with identical text', () => {
    const { chunks } = segmentDocument(blocks);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    let words = 0;
    for (const chunk of chunks) {
      for (const seg of wordSegmenter.segment(chunk.text)) {
        if (!seg.isWordLike) continue;
        const start = chunk.start + seg.index;
        const end = start + seg.segment.length;
        const range = core.rangeFor(blocks[chunk.block], start, end);
        expect(range, `word "${seg.segment}" in chunk ${chunk.idx}`).not.toBeNull();
        expect(range.toString()).toBe(seg.segment);
        words++;
      }
    }
    expect(words).toBeGreaterThan(30);
  });

  it('maps sentence ranges (multi-word, crossing inline boundaries)', () => {
    const { sentences } = segmentDocument(blocks);
    const p1Sentences = sentences.filter((s) => blocks[s.block].text.startsWith('First sentence'));
    expect(p1Sentences.length).toBe(2);
    const first = p1Sentences[0];
    const range = core.rangeFor(blocks[first.block], first.start, first.end);
    expect(range.toString().replace(/\s+/g, ' ')).toBe('First sentence with a boldword inside.');
  });
});

describe('blocksFromSelection', () => {
  it('clips to the selected portion across block boundaries', () => {
    const p1 = doc.getElementById('p1');
    const p2 = doc.getElementById('p2');
    const range = doc.createRange();
    range.setStart(p1.firstChild, 'First sentence '.length); // exactly at "with"
    range.setEnd(p2.firstChild, 'Para two'.length);
    const selection = { rangeCount: 1, getRangeAt: () => range };
    const sel = core.blocksFromSelection(selection, win);
    expect(sel.length).toBeGreaterThanOrEqual(2);
    expect(sel[0].text.startsWith('with a boldword')).toBe(true);
    expect(sel.at(-1).text).toBe('Para two');
    // clipped blocks still round-trip
    const { chunks } = segmentDocument(sel);
    const word = [...wordSegmenter.segment(chunks[0].text)].find((s) => s.isWordLike);
    const r = core.rangeFor(sel[chunks[0].block], chunks[0].start + word.index, chunks[0].start + word.index + word.segment.length);
    expect(r.toString()).toBe(word.segment);
  });

  it('returns null for collapsed or missing selections', () => {
    expect(core.blocksFromSelection(null, win)).toBeNull();
    const collapsed = doc.createRange();
    collapsed.setStart(doc.getElementById('p1').firstChild, 3);
    collapsed.collapse(true);
    expect(core.blocksFromSelection({ rangeCount: 1, getRangeAt: () => collapsed }, win)).toBeNull();
  });
});

describe('sliceFromCaret', () => {
  it('starts at the word under the caret and preserves offset mapping', () => {
    const p2 = doc.getElementById('p2');
    const textNode = p2.firstChild; // "Para two starts here. It keeps"
    const caretInsideStarts = 'Para two sta'.length;
    const sliced = core.sliceFromCaret(blocks, textNode, caretInsideStarts);
    expect(sliced[0].text.startsWith('starts here.')).toBe(true);
    const range = core.rangeFor(sliced[0], 0, 'starts'.length);
    expect(range.toString()).toBe('starts');
    // following blocks intact
    expect(sliced.some((b) => b.text === 'Item one text.')).toBe(true);
  });

  it('falls back to document order when the caret is not in collected text', () => {
    const navNode = doc.querySelector('nav li').firstChild;
    const sliced = core.sliceFromCaret(blocks, navNode, 0);
    expect(sliced).not.toBeNull();
    expect(sliced[0].text).toBe(blocks[0].text);
  });
});

describe('blocksAfter (re-read anchor)', () => {
  // An SPA thread: the toolbar click has to tell "pause" from "read the answer
  // that just arrived", and the only durable landmark is the DOM node the last
  // extraction ended in — chat pages repeat their own text constantly.
  const CHAT = `<!DOCTYPE html><html><body><main id="thread">
    <div><p>What is a lectern?</p></div>
    <div><p>A lectern is a reading stand.</p><p>It holds a book at eye level.</p></div>
  </main></body></html>`;

  let chatDoc;
  let chatWin;
  let thread;

  const read = () => core.collectBlocks(core.pickRoot(chatDoc), chatWin);
  const reply = (...paragraphs) => {
    const turn = chatDoc.createElement('div');
    for (const text of paragraphs) {
      const p = chatDoc.createElement('p');
      p.textContent = text;
      turn.appendChild(p);
    }
    thread.appendChild(turn);
  };

  beforeEach(() => {
    const chatDom = new JSDOM(CHAT);
    chatDoc = chatDom.window.document;
    chatWin = chatDom.window;
    thread = chatDoc.getElementById('thread');
  });

  it('returns nothing when the page has not grown', () => {
    expect(core.blocksAfter(read(), read())).toEqual([]);
  });

  it('returns only the blocks that arrived after the last read', () => {
    const first = read();
    reply('Ask a follow-up.', 'Here is the new answer.');
    expect(core.blocksAfter(first, read()).map((b) => b.text)).toEqual([
      'Ask a follow-up.',
      'Here is the new answer.',
    ]);
  });

  it('re-anchors on a tail slice, so the 2nd and 3rd re-read work too', () => {
    const first = read();
    reply('Second question.', 'Second answer.');
    const second = core.blocksAfter(first, read());
    expect(second.map((b) => b.text)).toEqual(['Second question.', 'Second answer.']);
    reply('Third question.', 'Third answer.');
    expect(core.blocksAfter(second, read()).map((b) => b.text)).toEqual([
      'Third question.',
      'Third answer.',
    ]);
  });

  it('anchors on DOM position, not text — a verbatim repeat is still new content', () => {
    const first = read();
    reply('It holds a book at eye level.'); // identical to the last block read
    expect(core.blocksAfter(first, read()).map((b) => b.text)).toEqual([
      'It holds a book at eye level.',
    ]);
  });

  it('returns blocks that landed mid-thread, not only appended ones', () => {
    const first = read();
    const inserted = chatDoc.createElement('p');
    inserted.textContent = 'Edited answer, inserted above.';
    thread.firstElementChild.appendChild(inserted);
    expect(core.blocksAfter(first, read())).toEqual([]); // still before the anchor
    reply('And a genuinely new turn.');
    expect(core.blocksAfter(first, read()).map((b) => b.text)).toEqual(['And a genuinely new turn.']);
  });

  it('returns null when the anchor is gone (the page re-rendered)', () => {
    const first = read();
    thread.replaceChildren();
    reply('A brand new conversation.');
    expect(core.blocksAfter(first, read())).toBeNull();
  });

  it('returns null for an empty previous extraction', () => {
    expect(core.blocksAfter([], read())).toBeNull();
  });
});

describe('oversized blocks', () => {
  // Pages that separate prose with <br> alone (or dump an article into one
  // <pre>) give the walker no flush point, so a whole article lands in one
  // block. /api/segment 413s the entire document over the per-block cap and
  // cannot split blocks itself, so the walker must.
  const collect = (html) => {
    const d = new JSDOM(`<!DOCTYPE html><html><body><article>${html}</article></body></html>`);
    return core.collectBlocks(core.pickRoot(d.window.document), d.window);
  };
  const tiles = (block) => {
    let covered = 0;
    for (const seg of block.segments) {
      expect(block.text.slice(seg.normStart, seg.normStart + seg.len)).toBe(
        seg.node.data.slice(seg.nodeStart, seg.nodeStart + seg.len),
      );
      covered += seg.len;
    }
    expect(covered).toBe(block.text.split(' ').join('').length);
  };

  const SENTENCE = 'This is one ordinary sentence of body prose that a page might contain. ';
  const PARA = SENTENCE.repeat(12);

  it('mirrors the server cap exactly', () => {
    expect(core.MAX_BLOCK_CHARS).toBe(MAX_BLOCK_CHARS);
  });

  it('splits a <br>-only article into blocks the server accepts', () => {
    const blocks = collect(Array.from({ length: 80 }, () => PARA).join('<br><br>'));
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocksOverLimit(blocks)).toBeNull();
    for (const b of blocks) {
      expect(b.text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
      expect(b.type).toBe('p');
      tiles(b);
    }
    // cuts land on sentence boundaries — no piece starts or ends mid-sentence
    for (const b of blocks.slice(0, -1)) expect(b.text.endsWith('contain.')).toBe(true);
    for (const b of blocks.slice(1)) expect(b.text.startsWith('This is one')).toBe(true);
  });

  it('keeps every word of a split block mappable back to a Range', () => {
    const blocks = collect(Array.from({ length: 80 }, () => PARA).join('<br><br>'));
    const { chunks } = segmentDocument(blocks);
    const sample = [chunks[0], chunks.at(-1), ...chunks.filter((c) => c.block > 0).slice(0, 2)];
    for (const chunk of sample) {
      for (const seg of wordSegmenter.segment(chunk.text)) {
        if (!seg.isWordLike) continue;
        const start = chunk.start + seg.index;
        const range = core.rangeFor(blocks[chunk.block], start, start + seg.segment.length);
        expect(range, `word "${seg.segment}" in chunk ${chunk.idx}`).not.toBeNull();
        expect(range.toString()).toBe(seg.segment);
      }
    }
  });

  it('falls back to word boundaries when no sentence boundary fits', () => {
    const blocks = collect(`<div>${'wordy '.repeat(12000)}</div>`); // 72k, no terminators
    expect(blocksOverLimit(blocks)).toBeNull();
    for (const b of blocks) {
      expect(b.text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
      expect(b.text.startsWith('wordy')).toBe(true);
      expect(b.text.endsWith('wordy')).toBe(true); // never cut mid-word
      tiles(b);
    }
    expect(blocks.map((b) => b.text.split(' ').length).reduce((a, c) => a + c)).toBe(12000);
  });

  it('hard-cuts an unbroken token rather than emitting an over-cap block', () => {
    const blocks = collect(`<div>${'x'.repeat(MAX_BLOCK_CHARS * 2 + 7)}</div>`);
    expect(blocksOverLimit(blocks)).toBeNull();
    expect(blocks.map((b) => b.text).join('')).toBe('x'.repeat(MAX_BLOCK_CHARS * 2 + 7));
    for (const b of blocks) {
      expect(b.text.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS);
      tiles(b);
    }
  });

  it('leaves normal blocks untouched (same objects, no copying)', () => {
    expect(blocks.every((b) => b.text.length <= MAX_BLOCK_CHARS)).toBe(true);
    const again = core.collectBlocks(core.pickRoot(doc), win);
    expect(again.map((b) => b.text)).toEqual(blocks.map((b) => b.text));
  });
});

describe('citation markers', () => {
  const read = (html) => {
    const d = new JSDOM(`<!DOCTYPE html><html><body><article>${html}</article></body></html>`);
    return { doc: d.window.document, blocks: core.collectBlocks(core.pickRoot(d.window.document), d.window) };
  };

  it('skips reference superscripts, so "[1][2]" is never read aloud', () => {
    const { blocks } = read(
      '<p>Turing was born in 1912.<sup class="reference"><a href="#cite_note-1">[1]</a></sup>' +
        '<sup class="reference"><a href="#cite_note-2">[2]</a></sup> He studied at King\'s.</p>',
    );
    expect(blocks.map((b) => b.text)).toEqual(["Turing was born in 1912. He studied at King's."]);
  });

  it('skips a [citation needed] superscript', () => {
    const { blocks } = read(
      '<p>A bold claim.<sup><i>[<a href="/wiki/Wikipedia:Citation_needed">citation needed</a>]</i></sup> More text.</p>',
    );
    expect(blocks.map((b) => b.text)).toEqual(['A bold claim. More text.']);
  });

  it('keeps superscripts without a link', () => {
    const { blocks } = read('<p>E = mc<sup>2</sup> held.</p>');
    expect(blocks.map((b) => b.text)).toEqual(['E = mc2 held.']);
  });

  it('still maps every word after a skipped marker to its live DOM range', () => {
    const { blocks } = read(
      '<p>Born in 1912.<sup><a href="#cite_note-1">[1]</a></sup> He studied mathematics.</p>',
    );
    const [block] = blocks;
    for (const { segment, index, isWordLike } of wordSegmenter.segment(block.text)) {
      if (!isWordLike) continue;
      expect(core.rangeFor(block, index, index + segment.length).toString()).toBe(segment);
    }
  });
});
