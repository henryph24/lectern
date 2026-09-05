const TAGS = { h1: 'h1', h2: 'h2', h3: 'h3', p: 'p', li: 'li', blockquote: 'blockquote' };

// Renders the article. Blocks start as plain text; sentence spans are injected
// lazily (IntersectionObserver near the viewport, or on demand when a chunk
// activates / a sentence is highlighted) so huge documents paint fast. While a
// chunk is active its sentences additionally get word-level spans (offsets
// arrive chunk-relative; chunk.start re-bases them onto the block text).
export function renderReader(container, doc) {
  const sentEls = new Array(doc.sentences.length);
  const sentencesByBlock = new Map();
  doc.sentences.forEach((s, si) => {
    if (!sentencesByBlock.has(s.block)) sentencesByBlock.set(s.block, []);
    sentencesByBlock.get(s.block).push(si);
  });

  const blockEls = new Array(doc.blocks.length);
  const blockSpansDone = new Array(doc.blocks.length).fill(false);

  const article = document.createElement('article');
  article.className = 'article';
  let listEl = null;
  let lastPage = null;
  doc.blocks.forEach((block, bi) => {
    // hasOwn, not TAGS[...]: a block typed 'constructor' would otherwise yield
    // a function, and createElement throws on it — one bad block would make the
    // whole document unopenable.
    const el = document.createElement(Object.hasOwn(TAGS, block.type) ? TAGS[block.type] : 'p');
    el.className = 'block';
    el.dataset.b = bi;
    el.textContent = block.text;
    if (block.page && block.page !== lastPage) {
      el.dataset.page = block.page;
      lastPage = block.page;
    }
    blockEls[bi] = el;
    if (block.type === 'li') {
      if (!listEl) {
        listEl = document.createElement('ul');
        listEl.className = 'block-list';
        article.appendChild(listEl);
      }
      listEl.appendChild(el);
    } else {
      listEl = null;
      article.appendChild(el);
    }
  });
  container.appendChild(article);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          ensureBlockSpans(Number(entry.target.dataset.b));
          observer.unobserve(entry.target);
        }
      }
    },
    { rootMargin: '150% 0px' },
  );
  blockEls.forEach((el) => observer.observe(el));

  function ensureBlockSpans(bi) {
    if (bi == null || Number.isNaN(bi) || blockSpansDone[bi]) return;
    blockSpansDone[bi] = true;
    const el = blockEls[bi];
    const block = doc.blocks[bi];
    el.textContent = '';
    let cursor = 0;
    for (const si of sentencesByBlock.get(bi) ?? []) {
      const s = doc.sentences[si];
      if (s.start > cursor) el.appendChild(document.createTextNode(block.text.slice(cursor, s.start)));
      const span = document.createElement('span');
      span.className = 'sent';
      span.dataset.s = si;
      span.textContent = block.text.slice(s.start, s.end);
      el.appendChild(span);
      sentEls[si] = span;
      cursor = s.end;
    }
    if (cursor < block.text.length) el.appendChild(document.createTextNode(block.text.slice(cursor)));
  }

  let activeChunk = null;
  let wordEls = [];
  let wordSentence = [];
  let activeWordEl = null;
  let activeSentEl = null;

  function activateChunk(chunk, words) {
    deactivateChunk();
    ensureBlockSpans(chunk.block);
    activeChunk = chunk;
    wordEls = new Array(words.length).fill(null);
    wordSentence = new Array(words.length).fill(-1);

    const blockText = doc.blocks[chunk.block].text;
    const bySentence = new Map();
    let minStart = 0;
    words.forEach((w, wi) => {
      if (w.charStart < 0) return;
      const abs = chunk.start + w.charStart;
      if (abs < minStart) return; // tolerate out-of-order data
      for (let si = chunk.sentences[0]; si <= chunk.sentences[1]; si++) {
        const s = doc.sentences[si];
        if (abs >= s.start && abs < s.end) {
          if (!bySentence.has(si)) bySentence.set(si, []);
          bySentence.get(si).push(wi);
          wordSentence[wi] = si;
          minStart = Math.min(chunk.start + w.charEnd, s.end);
          break;
        }
      }
    });

    // words with no char match still need a sentence for highlight continuity:
    // inherit from the previous matched word (or the chunk's first sentence)
    let lastSeen = chunk.sentences[0];
    for (let wi = 0; wi < words.length; wi++) {
      if (wordSentence[wi] === -1) wordSentence[wi] = lastSeen;
      else lastSeen = wordSentence[wi];
    }

    for (const [si, wis] of bySentence) {
      const s = doc.sentences[si];
      const frag = document.createDocumentFragment();
      let cursor = s.start;
      for (const wi of wis) {
        const w = words[wi];
        const abs = chunk.start + w.charStart;
        const absEnd = Math.min(chunk.start + w.charEnd, s.end);
        if (abs < cursor || absEnd <= abs) continue;
        if (abs > cursor) frag.appendChild(document.createTextNode(blockText.slice(cursor, abs)));
        const wEl = document.createElement('span');
        wEl.className = 'w';
        wEl.textContent = blockText.slice(abs, absEnd);
        frag.appendChild(wEl);
        wordEls[wi] = wEl;
        cursor = absEnd;
      }
      if (cursor < s.end) frag.appendChild(document.createTextNode(blockText.slice(cursor, s.end)));
      sentEls[si].textContent = '';
      sentEls[si].appendChild(frag);
    }
  }

  function deactivateChunk() {
    if (!activeChunk) return;
    clearWordHighlight();
    for (let si = activeChunk.sentences[0]; si <= activeChunk.sentences[1]; si++) {
      const s = doc.sentences[si];
      if (sentEls[si]) sentEls[si].textContent = doc.blocks[s.block].text.slice(s.start, s.end);
    }
    activeChunk = null;
    wordEls = [];
    wordSentence = [];
  }

  function clearWordHighlight() {
    activeWordEl?.classList.remove('is-active');
    activeWordEl = null;
  }

  function highlightWord(wi) {
    const el = wordEls[wi] ?? null;
    if (el !== activeWordEl) {
      activeWordEl?.classList.remove('is-active');
      el?.classList.add('is-active');
      activeWordEl = el;
    }
    return wordSentence[wi] ?? -1;
  }

  function highlightSentence(si) {
    ensureBlockSpans(doc.sentences[si]?.block);
    const el = sentEls[si] ?? null;
    if (el === activeSentEl) return;
    activeSentEl?.classList.remove('is-active');
    el?.classList.add('is-active');
    activeSentEl = el;
  }

  function scrollToSentence(si) {
    ensureBlockSpans(doc.sentences[si]?.block);
    sentEls[si]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function onSentenceClick(cb) {
    article.addEventListener('click', (e) => {
      const sent = e.target.closest('.sent');
      if (sent?.dataset.s != null) return cb(Number(sent.dataset.s));
      // block not yet span-injected (clicked faster than the observer):
      // resolve the sentence from the caret offset in the plain text node
      const blockEl = e.target.closest('.block');
      if (!blockEl?.dataset.b) return;
      const bi = Number(blockEl.dataset.b);
      if (blockSpansDone[bi]) return;
      const si = sentenceAtPoint(bi, e) ?? (sentencesByBlock.get(bi) ?? [])[0];
      if (si != null) cb(si);
    });
  }

  function sentenceAtPoint(bi, e) {
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    const node = range?.startContainer;
    if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement !== blockEls[bi]) return null;
    for (const si of sentencesByBlock.get(bi) ?? []) {
      const s = doc.sentences[si];
      if (range.startOffset >= s.start && range.startOffset < s.end) return si;
    }
    return null;
  }

  return {
    activateChunk,
    highlightWord,
    highlightSentence,
    scrollToSentence,
    onSentenceClick,
    dispose() {
      observer.disconnect();
    },
  };
}
