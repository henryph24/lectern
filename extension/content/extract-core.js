// Lectern extract core — pure DOM→blocks walker with a normalized-run offset
// index, so server word offsets (over normalized block text) map back to live
// DOM Ranges. Classic script (content scripts can't use modules): exposes
// globalThis.__lecternCore. Loaded by engine.js (MAIN world) and by vitest.
(() => {
  // whitespace incl. NBSP (matched by \s in JS) plus zero-width chars
  const WS = /[\s\u200B-\u200D\uFEFF]/;

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'PICTURE', 'IMG', 'MAP',
    'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'DIALOG',
    'FORM', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'LABEL', 'OPTION',
    'FIGURE', 'FIGCAPTION',
  ]);

  // ARIA twins of SKIP_TAGS: SPAs mark their chrome with landmark roles on
  // divs/custom elements instead of semantic tags (Gemini's whole sidebar is
  // <bard-sidenav role="navigation"> inside <main>)
  const SKIP_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary',
    'dialog', 'alertdialog', 'form', 'search',
  ]);

  const BLOCK_TYPE = {
    H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3',
    P: 'p', LI: 'li', BLOCKQUOTE: 'blockquote', PRE: 'p', DT: 'p', DD: 'p',
  };

  const BLOCKISH_DISPLAY = new Set([
    'block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'table-cell',
    'table-caption', 'flow-root',
  ]);
  // fallback when getComputedStyle yields no display (minimal DOM impls)
  const BLOCKISH_TAGS = new Set([
    'DIV', 'P', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'SECTION', 'ARTICLE',
    'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE',
    'TABLE', 'TR', 'TD', 'TH', 'HR',
  ]);

  // Mirrors MAX_BLOCK_CHARS in server/lib/limits.js. /api/segment rejects the
  // WHOLE document when one block is longer, and it cannot split blocks itself
  // (block indices are the caller's offset→DOM mapping), so the walker is the
  // only place a cap can be enforced. Pages that separate prose with <br>
  // alone, or dump an article into one <pre>/inline container, offer no flush
  // point at all — without this cap they become one unreadable mega-block.
  const MAX_BLOCK_CHARS = 50_000;

  // built on first oversized block only: this script loads on every page
  const segmenters = {};
  const segmenterFor = (granularity) =>
    (segmenters[granularity] ??= new Intl.Segmenter('en', { granularity }));

  // bitmask literals from compareDocumentPosition (Node may not be global here)
  const POSITION_FOLLOWING = 0x04;
  const POSITION_CONTAINED_BY = 0x10;

  function pickRoot(doc) {
    return (
      doc.querySelector('article') ??
      doc.querySelector('main') ??
      doc.querySelector('[role="main"]') ??
      doc.body
    );
  }

  // A standalone block over [start, end) of another block's normalized text,
  // with the run index rebased (and clipped) so Ranges still resolve.
  function sliceBlock(block, start, end) {
    const segments = [];
    for (const seg of block.segments) {
      const segEnd = seg.normStart + seg.len;
      if (segEnd <= start || seg.normStart >= end) continue;
      const skip = Math.max(0, start - seg.normStart);
      const clip = Math.max(0, segEnd - end);
      segments.push({
        normStart: seg.normStart + skip - start,
        len: seg.len - skip - clip,
        node: seg.node,
        nodeStart: seg.nodeStart + skip,
      });
    }
    return { type: block.type, text: block.text.slice(start, end), segments };
  }

  // Last boundary in `head`, or 0 when it holds none.
  function lastBoundary(head, granularity) {
    let cut = 0;
    for (const { index } of segmenterFor(granularity).segment(head)) {
      if (index > 0) cut = index;
    }
    return cut;
  }

  // Split an over-long block into cap-sized pieces, cutting at the last
  // sentence boundary that fits — a word boundary inside a sentence that is
  // itself over the cap, and only then a hard cut (an unbroken 50k token).
  function capBlock(block) {
    const { text } = block;
    if (text.length <= MAX_BLOCK_CHARS) return [block];
    const out = [];
    let start = 0;
    while (text.length - start > MAX_BLOCK_CHARS) {
      const head = text.slice(start, start + MAX_BLOCK_CHARS + 1);
      const cut = lastBoundary(head, 'sentence') || lastBoundary(head, 'word') || MAX_BLOCK_CHARS;
      const end = start + cut;
      // the text is single-spaced, so a cut may land either side of a separator
      // space, which belongs to no run — never leave one dangling on a piece
      out.push(sliceBlock(block, start, text[end - 1] === ' ' ? end - 1 : end));
      start = text[end] === ' ' ? end + 1 : end;
    }
    out.push(sliceBlock(block, start, text.length));
    return out;
  }

  function collectBlocks(root, win, clipRange = null) {
    const blocks = [];
    let current = null;

    const flush = () => {
      if (!current) return;
      if (current.text.endsWith(' ')) {
        current.text = current.text.slice(0, -1);
      }
      if (current.text) blocks.push(...capBlock(current));
      current = null;
    };

    const ensure = (type) => {
      if (!current) current = { type: type ?? 'p', text: '', segments: [] };
    };

    const appendText = (textNode) => {
      let content = textNode.data;
      let base = 0;
      if (clipRange) {
        if (!clipRange.intersectsNode(textNode)) return;
        if (textNode === clipRange.startContainer) {
          base = clipRange.startOffset;
          content = content.slice(base);
        }
        if (textNode === clipRange.endContainer) {
          content = content.slice(0, clipRange.endOffset - base);
        }
      }
      if (!content) return;
      ensure(current?.type);
      let runStart = -1;
      for (let i = 0; i <= content.length; i++) {
        const ch = i < content.length ? content[i] : null;
        if (ch !== null && !WS.test(ch)) {
          if (runStart === -1) runStart = i;
          continue;
        }
        if (runStart !== -1) {
          current.segments.push({
            normStart: current.text.length,
            len: i - runStart,
            node: textNode,
            nodeStart: base + runStart,
          });
          current.text += content.slice(runStart, i);
          runStart = -1;
        }
        if (ch !== null && current.text && !current.text.endsWith(' ')) {
          current.text += ' ';
        }
      }
    };

    const visit = (node) => {
      if (node.nodeType === 3) {
        appendText(node);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName;
      if (SKIP_TAGS.has(tag)) return;
      // footnote/citation markers ([1], [citation needed]) are a <sup> around a
      // link; a link-free <sup> (an exponent) is content. Mirrors
      // server/lib/extract/blocks.js so both surfaces read the same words.
      if (tag === 'SUP' && el.querySelector('a')) return;
      const role = el.getAttribute('role');
      if (role && SKIP_ROLES.has(role.trim().toLowerCase())) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      const editable = el.getAttribute('contenteditable');
      if (editable === '' || editable === 'true') return;

      if (tag === 'BR') {
        if (current && current.text && !current.text.endsWith(' ')) current.text += ' ';
        return;
      }

      let style = null;
      try {
        style = win.getComputedStyle(el);
      } catch {
        // detached or foreign element — walk on
      }
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return;

      const display = style?.display || '';
      const blockish = display ? BLOCKISH_DISPLAY.has(display) : BLOCKISH_TAGS.has(tag);
      const type = BLOCK_TYPE[tag];

      if (blockish || type) flush();
      if (type) ensure(type);
      for (const child of el.childNodes) visit(child);
      if (blockish || type) flush();
    };

    visit(root);
    flush();
    return blocks;
  }

  function blocksFromSelection(selection, win) {
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return null;
    let root = range.commonAncestorContainer;
    if (root.nodeType === 3) root = root.parentElement;
    if (!root) return null;
    const blocks = collectBlocks(root, win, range);
    return blocks.length ? blocks : null;
  }

  function segmentForStart(segments, offset) {
    let lo = 0;
    let hi = segments.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].normStart <= offset) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best >= 0 && offset < segments[best].normStart + segments[best].len) return best;
    return best + 1 < segments.length ? best + 1 : -1; // snap forward off a collapsed space
  }

  function segmentForEnd(segments, lastChar) {
    let lo = 0;
    let hi = segments.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid].normStart <= lastChar) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best; // snap backward off a collapsed space
  }

  // Range over [start, end) of the block's normalized text
  function rangeFor(block, start, end) {
    const { segments } = block;
    if (!segments.length || end <= start) return null;
    const sIdx = segmentForStart(segments, start);
    const eIdx = segmentForEnd(segments, end - 1);
    if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) return null;
    const s = segments[sIdx];
    const e = segments[eIdx];
    const startOffset = Math.max(0, start - s.normStart);
    const endOffset = Math.min(e.len, end - e.normStart);
    if (!s.node.isConnected || !e.node.isConnected) return null;
    const range = s.node.ownerDocument.createRange();
    range.setStart(s.node, s.nodeStart + startOffset);
    range.setEnd(e.node, e.nodeStart + endOffset);
    return range;
  }

  function locate(blocks, node, offset) {
    for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
      for (const seg of blocks[blockIdx].segments) {
        if (seg.node === node && offset >= seg.nodeStart && offset <= seg.nodeStart + seg.len) {
          return { blockIdx, normOffset: seg.normStart + (offset - seg.nodeStart) };
        }
      }
    }
    return null;
  }

  // Slice the block list so reading starts at the caret (snapped back to the
  // start of the word under it). Falls back to document order when the caret
  // is not inside collected text.
  function sliceFromCaret(blocks, node, offset) {
    let loc = locate(blocks, node, offset);
    if (!loc) {
      const target =
        node.nodeType === 1 && node.childNodes.length
          ? node.childNodes[Math.min(offset, node.childNodes.length - 1)]
          : node;
      for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
        const segNode = blocks[blockIdx].segments[0]?.node;
        if (!segNode) continue;
        const pos = target.compareDocumentPosition(segNode);
        if (segNode === target || pos & POSITION_FOLLOWING || pos & POSITION_CONTAINED_BY) {
          loc = { blockIdx, normOffset: 0 };
          break;
        }
      }
    }
    if (!loc) return null;

    const { blockIdx } = loc;
    const first = blocks[blockIdx];
    let cut = loc.normOffset;
    while (cut > 0 && first.text[cut - 1] !== ' ') cut--;

    const out = [];
    if (cut < first.text.length) out.push(sliceBlock(first, cut, first.text.length));
    out.push(...blocks.slice(blockIdx + 1));
    return out.length ? out : null;
  }

  // Where an earlier extraction ended inside a fresh one, anchored on the DOM
  // node its last block ended in — never on text, since chat pages repeat
  // themselves constantly. Returns the blocks that came after it, [] when
  // nothing is new, or null when the anchor is gone (the page re-rendered, so
  // the caller should re-read it whole). Anchoring on the LAST block rather
  // than diffing a prefix is what keeps this working on the 2nd, 3rd, … call,
  // where `prev` is itself a tail slice sharing no prefix with the page.
  function blocksAfter(prev, fresh) {
    const last = prev[prev.length - 1];
    const seg = last?.segments[last.segments.length - 1];
    if (!seg || !seg.node.isConnected) return null;
    const loc = locate(fresh, seg.node, seg.nodeStart + seg.len);
    if (!loc) return null;
    return fresh.slice(loc.blockIdx + 1);
  }

  globalThis.__lecternCore = {
    MAX_BLOCK_CHARS,
    pickRoot,
    collectBlocks,
    blocksFromSelection,
    rangeFor,
    locate,
    sliceFromCaret,
    blocksAfter,
  };
})();
