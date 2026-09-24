// Lectern page engine (MAIN world — required for CSS.highlights to paint).
// Owns: DOM extraction (via __lecternCore), word/sentence karaoke highlights,
// auto-scroll, and the floating player UI. No page DOM is ever mutated for
// highlighting. Talks to the service worker through the isolated bridge with
// window.postMessage envelopes.
(() => {
  if (window.__lecternEngine) return;
  window.__lecternEngine = true;

  const core = globalThis.__lecternCore;
  if (!core) return;

  const up = (msg) => window.postMessage({ __lectern: 'up', msg }, '*');

  /* ——— caret capture for "read from here" ——— */

  let lastCaret = null;
  document.addEventListener(
    'contextmenu',
    (e) => {
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (range) lastCaret = { node: range.startContainer, offset: range.startOffset };
    },
    { capture: true, passive: true },
  );

  /* ——— session state ——— */

  let live = null; // { blocks(with segments), bounded, sentences, chunks(meta), chunkWords: Map, sync, lastWord, lastSentence, raf }
  const wordHl = new Highlight();
  const sentHl = new Highlight();
  wordHl.priority = 2;
  sentHl.priority = 1;

  let ui = null;
  let barPos = null; // px position once dragged; survives close/reopen for the page's life
  let userScrolledAt = 0;
  let programmaticUntil = 0;
  const markScroll = () => {
    if (performance.now() > programmaticUntil) userScrolledAt = performance.now();
  };
  window.addEventListener('wheel', markScroll, { passive: true });
  window.addEventListener('touchmove', markScroll, { passive: true });

  /* ——— extraction ——— */

  function extract(mode, hasSession) {
    const pageBlocks = () => core.collectBlocks(core.pickRoot(document), window);
    if (mode === 'selection') {
      const blocks = core.blocksFromSelection(window.getSelection(), window);
      if (!blocks) return { error: 'Select some text first, then choose “read selection”.' };
      return { blocks, bounded: true };
    }
    if (mode === 'caret' && lastCaret) {
      const all = pageBlocks();
      const blocks = core.sliceFromCaret(all, lastCaret.node, lastCaret.offset) ?? all;
      return { blocks };
    }
    if (mode === 'auto') return resolveAuto(pageBlocks, hasSession);
    const blocks = pageBlocks();
    if (!blocks.length) return { error: 'No readable text found on this page.' };
    return { blocks };
  }

  // The toolbar click is a "read this" gesture, not a transport control, and
  // only the page can tell "pause" from "read what just appeared": it alone
  // sees the live DOM, the selection, and the blocks the session was built
  // from. Resolution order — a selection wins, then a page we aren't already
  // reading, then whatever the page grew since we extracted it (an SPA chat
  // answer, a new feed item), and only then play/pause.
  function resolveAuto(pageBlocks, hasSession) {
    const selected = core.blocksFromSelection(window.getSelection(), window);
    if (selected) return { blocks: selected, bounded: true };

    const all = pageBlocks();
    // No live session (first click, or the page reloaded under a session the
    // service worker still holds) → read the page. Same when the SW no longer
    // has the session: resolving to a toggle it would drop is a dead click.
    if (!live?.blocks?.length || !hasSession) {
      if (!all.length) return { error: 'No readable text found on this page.' };
      return { blocks: all };
    }
    // A selection-derived session is mid-page by definition, so "everything
    // after it" is the rest of the article, not newly arrived content.
    if (!live.bounded) {
      const grown = core.blocksAfter(live.blocks, all);
      if (grown === null) return all.length ? { blocks: all } : { toggle: true }; // page re-rendered
      if (grown.length) return { blocks: grown, grew: true };
    }
    return { toggle: true };
  }

  // `nonce` is the one-shot authorization the service worker minted for the
  // user's gesture on THIS document; it is the only thing that lets our
  // session-start through. Everything else in this file runs in the page's own
  // world and is therefore untrusted by design.
  function begin(mode, hasSession, nonce) {
    const { blocks, error, toggle, bounded, grew } = extract(mode, hasSession);
    if (toggle) {
      up({ type: 'control', action: 'toggle' }); // nothing new to read — transport control
      return;
    }
    teardown(false);
    if (error) {
      mountUi();
      setStatus('error', error);
      return;
    }
    live = {
      blocks,
      bounded: Boolean(bounded),
      sentences: null,
      chunks: null,
      chunkWords: new Map(),
      sync: null,
      lastWordIdx: -1,
      lastSentence: -1,
      raf: 0,
    };
    mountUi();
    setStatus('loading', grew ? 'Reading what’s new…' : 'Preparing…');
    // Title and URL are deliberately absent: the service worker takes them from
    // the browser, so a page cannot assert provenance for a library entry.
    up({
      type: 'session-start',
      nonce,
      blocks: blocks.map((b) => ({ type: b.type, text: b.text })),
    });
  }

  /* ——— highlights ——— */

  function registerHighlights() {
    CSS.highlights.set('lectern-word', wordHl);
    CSS.highlights.set('lectern-sentence', sentHl);
  }

  function clearHighlights() {
    wordHl.clear();
    sentHl.clear();
    CSS.highlights.delete('lectern-word');
    CSS.highlights.delete('lectern-sentence');
  }

  function buildChunkWords(idx, words) {
    if (!live?.chunks) return;
    const chunk = live.chunks[idx];
    const block = live.blocks[chunk.block];
    const built = words.map((w) => {
      if (w.charStart < 0) return { ...w, range: null, sentence: -1 };
      const start = chunk.start + w.charStart;
      const range = core.rangeFor(block, start, chunk.start + w.charEnd);
      let sentence = -1;
      for (let si = chunk.sentences[0]; si <= chunk.sentences[1]; si++) {
        const s = live.sentences[si];
        if (start >= s.start && start < s.end) {
          sentence = si;
          break;
        }
      }
      return { ...w, range, sentence };
    });
    let lastSeen = chunk.sentences[0];
    for (const w of built) {
      if (w.sentence === -1) w.sentence = lastSeen;
      else lastSeen = w.sentence;
    }
    live.chunkWords.set(idx, built);
    for (const old of live.chunkWords.keys()) {
      if (Math.abs(old - idx) > 2) live.chunkWords.delete(old);
    }
  }

  function sentenceRange(si) {
    const s = live.sentences[si];
    return core.rangeFor(live.blocks[s.block], s.start, s.end);
  }

  function tick() {
    live.raf = requestAnimationFrame(tick);
    const sync = live?.sync;
    if (!sync) return;
    const words = live.chunkWords.get(sync.idx);
    if (!words?.length) return;
    const t = sync.ms + (sync.playing ? (performance.now() - sync.recvAt) * sync.rate : 0);

    let lo = 0;
    let hi = words.length - 1;
    let wi = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].startMs <= t) {
        wi = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (wi === live.lastWordIdx || wi < 0) return;
    live.lastWordIdx = wi;

    const word = words[wi];
    wordHl.clear();
    if (word.range && word.range.startContainer.isConnected) wordHl.add(word.range);

    if (word.sentence !== live.lastSentence && word.sentence >= 0) {
      live.lastSentence = word.sentence;
      const range = sentenceRange(word.sentence);
      sentHl.clear();
      if (range) {
        sentHl.add(range);
        if (performance.now() - userScrolledAt > 3000) {
          programmaticUntil = performance.now() + 1000;
          (range.startContainer.parentElement ?? range.startContainer).scrollIntoView?.({
            behavior: 'smooth',
            block: 'center',
          });
        }
      }
    }
  }

  /* ——— sentence skip / seek / click-to-jump ——— */

  function jumpToSentence(si) {
    if (!live?.chunks) return;
    const chunkIdx = live.chunks.findIndex((c) => si >= c.sentences[0] && si <= c.sentences[1]);
    if (chunkIdx === -1) return;
    const charStart = Math.max(0, live.sentences[si].start - live.chunks[chunkIdx].start);
    live.lastWordIdx = -1;
    live.lastSentence = si;
    const range = sentenceRange(si);
    wordHl.clear();
    sentHl.clear();
    if (range) sentHl.add(range);
    up({ type: 'seek', chunkIdx, charStart });
  }

  function skipSentence(dir) {
    if (!live?.sentences) return;
    const from = live.lastSentence >= 0 ? live.lastSentence : 0;
    jumpToSentence(Math.max(0, Math.min(from + dir, live.sentences.length - 1)));
  }

  function sentenceAtOffset(blockIdx, offset) {
    let fallback = -1;
    for (let si = 0; si < live.sentences.length; si++) {
      const s = live.sentences[si];
      if (s.block !== blockIdx) continue;
      if (fallback === -1) fallback = si;
      if (offset >= s.start && offset < s.end) return si;
      if (offset < s.start) return si; // clicked the gap before this sentence
    }
    return fallback;
  }

  const INTERACTIVE =
    'a, button, input, select, textarea, summary, label, [contenteditable], ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"]';

  // Speechify-style click-to-jump: while a session is active, clicking read
  // text seeks the audio there. Capture phase so SPA handlers that stop
  // propagation can't hide clicks from us; we never preventDefault, so the
  // page's own behavior is untouched.
  document.addEventListener(
    'click',
    (e) => {
      if (!live?.chunks || !live.sentences) return;
      if (ui && ui.host.contains(e.target)) return;
      if (e.target.closest?.(INTERACTIVE)) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return; // they're selecting, not jumping
      const range = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (!range) return;
      const loc = core.locate(live.blocks, range.startContainer, range.startOffset);
      if (!loc) return;
      const si = sentenceAtOffset(loc.blockIdx, loc.normOffset);
      if (si >= 0) jumpToSentence(si);
    },
    true,
  );

  /* ——— floating UI (shadow DOM) ——— */

  const UI_CSS = `
    :host { all: initial; position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
            z-index: 2147483647; font-family: -apple-system, 'Helvetica Neue', sans-serif; }
    .bar { display: flex; align-items: center; gap: 10px; background: #211d16; color: #f4eee1;
           border-radius: 18px; padding: 10px 14px; box-shadow: 0 18px 50px -12px rgba(0,0,0,.55);
           min-width: 380px; cursor: grab; user-select: none; -webkit-user-select: none;
           touch-action: none; }
    .bar.dragging { cursor: grabbing; }
    button { all: unset; cursor: pointer; display: grid; place-items: center; border-radius: 50%;
             width: 34px; height: 34px; color: #f4eee1; font-size: 15px; line-height: 1; }
    button:hover { background: #383226; }
    .play { width: 42px; height: 42px; background: #c8401f; font-size: 17px; }
    .play:hover { background: #d8512e; }
    .status { flex: 1; min-width: 0; font-size: 12px; color: #9b9077; white-space: nowrap;
              overflow: hidden; text-overflow: ellipsis; }
    .status.err { color: #e8927c; }
    .rate { display: flex; align-items: center; gap: 2px; background: #383226; border-radius: 999px;
            padding: 2px 4px; }
    .rate button { width: 24px; height: 24px; font-size: 13px; }
    .rate span { font-size: 12px; min-width: 30px; text-align: center; font-variant-numeric: tabular-nums; }
    select { all: unset; background: #383226; border-radius: 999px; padding: 7px 12px; font-size: 12px;
             max-width: 110px; text-overflow: ellipsis; overflow: hidden; cursor: pointer; }
    .spin { width: 16px; height: 16px; border: 2px solid rgba(244,238,225,.3); border-top-color: #f4eee1;
            border-radius: 50%; animation: spin .8s linear infinite; display: none; }
    .loading .spin { display: block; }
    .loading .playglyph { display: none; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  // MAIN-world code runs under the page's CSP: sites enforcing Trusted Types
  // (gemini.google.com & other Google properties) throw on any innerHTML
  // assignment, so the bar must be built with createElement only.
  function el(tag, className, text = '', title = '') {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    if (title) node.title = title;
    return node;
  }

  function mountUi() {
    if (ui) return;
    const host = document.createElement('div');
    host.setAttribute('data-lectern', '');
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS);
    root.adoptedStyleSheets = [sheet];

    const bar = el('div', 'bar');
    const play = el('button', 'play', '', 'Play / pause');
    play.append(el('span', 'playglyph', '⏸'), el('span', 'spin'));
    const rate = el('span', 'rate');
    rate.append(el('button', 'slower', '−'), el('span', 'rateval', '1×'), el('button', 'faster', '+'));
    bar.append(
      play,
      el('button', 'prev', '⏮', 'Previous sentence'),
      el('button', 'next', '⏭', 'Next sentence'),
      el('span', 'status', 'Lectern'),
      rate,
      el('select', 'voice', '', 'Voice'),
      el('button', 'save', '🔖', 'Save to Lectern library'),
      el('button', 'close', '✕', 'Stop reading'),
    );
    root.appendChild(bar);
    document.documentElement.appendChild(host);

    const q = (sel) => bar.querySelector(sel);
    ui = {
      host,
      bar,
      play: q('.play'),
      playGlyph: q('.playglyph'),
      status: q('.status'),
      rateVal: q('.rateval'),
      voice: q('.voice'),
      rate: 1,
    };

    q('.play').addEventListener('click', () => up({ type: 'control', action: 'toggle' }));
    q('.prev').addEventListener('click', () => skipSentence(-1));
    q('.next').addEventListener('click', () => skipSentence(1));
    q('.slower').addEventListener('click', () => setRate(ui.rate - 0.25));
    q('.faster').addEventListener('click', () => setRate(ui.rate + 0.25));
    q('.save').addEventListener('click', () => up({ type: 'save-library' }));
    q('.close').addEventListener('click', () => {
      up({ type: 'session-end' });
      teardown(true);
    });
    ui.voice.addEventListener('change', () => {
      const [provider, ...rest] = ui.voice.value.split(':');
      up({ type: 'voice', provider, voice: rest.join(':') });
    });

    enableDrag();
    if (barPos) placeBar(barPos);
  }

  // The bar mounts bottom-centered (:host rule). Dragging any non-control area
  // pins the host to px coordinates — inline styles beat the :host rule — and
  // barPos makes a remount come back where the user left it.
  function placeBar(pos) {
    const margin = 8;
    const rect = ui.host.getBoundingClientRect();
    barPos = {
      left: Math.min(Math.max(pos.left, margin), Math.max(margin, window.innerWidth - rect.width - margin)),
      top: Math.min(Math.max(pos.top, margin), Math.max(margin, window.innerHeight - rect.height - margin)),
    };
    ui.host.style.left = `${barPos.left}px`;
    ui.host.style.top = `${barPos.top}px`;
    ui.host.style.bottom = 'auto';
    ui.host.style.transform = 'none';
  }

  function enableDrag() {
    const { bar } = ui;
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, select')) return;
      const rect = ui.host.getBoundingClientRect();
      drag = { fromX: e.clientX, fromY: e.clientY, left: rect.left, top: rect.top, moved: false };
      bar.setPointerCapture(e.pointerId);
      e.preventDefault(); // no text selection while dragging
    });
    bar.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.fromX;
      const dy = e.clientY - drag.fromY;
      if (!drag.moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; // plain clicks never reposition
      drag.moved = true;
      bar.classList.add('dragging');
      placeBar({ left: drag.left + dx, top: drag.top + dy });
    });
    const endDrag = () => {
      drag = null;
      bar.classList.remove('dragging');
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
  }

  window.addEventListener('resize', () => {
    if (ui && barPos) placeBar(barPos); // keep a pinned bar on-screen
  });

  function setRate(value) {
    const rate = Math.min(3, Math.max(0.5, Math.round(value * 4) / 4));
    ui.rate = rate;
    ui.rateVal.textContent = `${rate}×`;
    up({ type: 'rate', value: rate });
  }

  function setStatus(kind, text) {
    if (!ui) return;
    ui.status.textContent = text ?? '';
    ui.status.classList.toggle('err', kind === 'error');
    ui.bar.classList.toggle('loading', kind === 'loading');
    if (kind === 'playing') ui.playGlyph.textContent = '⏸';
    if (kind === 'paused' || kind === 'ended' || kind === 'error') ui.playGlyph.textContent = '▶';
  }

  function fillVoices(voices, prefs) {
    if (!ui || !voices) return;
    ui.voice.replaceChildren();
    const addGroup = (label, provider, list) => {
      if (!list?.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const v of list) {
        const option = document.createElement('option');
        option.value = `${provider}:${v.id}`;
        option.textContent = v.label;
        group.appendChild(option);
      }
      ui.voice.appendChild(group);
    };
    addGroup('Edge — free', 'edge', voices.edge?.voices);
    if (voices.elevenlabs?.available) addGroup('ElevenLabs', 'elevenlabs', voices.elevenlabs.voices);
    if (voices.supertonic?.available) addGroup('Supertonic — on-device', 'supertonic', voices.supertonic.voices);
    if (voices.kokoro?.available) addGroup('Kokoro — on-device', 'kokoro', voices.kokoro.voices);
    const want = `${prefs.provider}:${prefs.voice}`;
    if ([...ui.voice.options].some((o) => o.value === want)) ui.voice.value = want;
  }

  function teardown(removeUi) {
    if (live?.raf) cancelAnimationFrame(live.raf);
    clearHighlights();
    live = null;
    if (removeUi && ui) {
      ui.host.remove();
      ui = null;
    }
  }

  /* ——— message handling ——— */

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lectern !== 'down') return;
    const msg = e.data.msg;
    switch (msg.type) {
      case 'begin':
        begin(msg.mode, Boolean(msg.hasSession), msg.nonce);
        break;
      case 'segmented':
        if (!live) break;
        live.sentences = msg.sentences;
        live.chunks = msg.chunks;
        registerHighlights();
        fillVoices(msg.voices, msg.prefs);
        if (msg.prefs && ui) {
          ui.rate = msg.prefs.rate ?? 1;
          ui.rateVal.textContent = `${ui.rate}×`;
        }
        setStatus('loading', 'Synthesizing…');
        if (!live.raf) live.raf = requestAnimationFrame(tick);
        break;
      case 'chunk':
        if (!live) break;
        buildChunkWords(msg.idx, msg.words);
        live.lastWordIdx = -1;
        break;
      case 'time':
        if (!live) break;
        live.sync = { idx: msg.idx, ms: msg.ms, rate: msg.rate, playing: msg.playing, recvAt: performance.now() };
        break;
      case 'state':
        if (msg.state === 'playing') setStatus('playing', 'Reading aloud');
        else if (msg.state === 'paused') setStatus('paused', 'Paused');
        else if (msg.state === 'loading') setStatus('loading', 'Synthesizing…');
        else if (msg.state === 'ended') setStatus('ended', 'Finished');
        else if (msg.state === 'error') setStatus('error', msg.message ?? 'Something went wrong');
        break;
      case 'saved':
        setStatus('playing', 'Saved to library ✓');
        break;
      case 'error':
        mountUi();
        setStatus('error', msg.message);
        break;
      case 'teardown':
        teardown(true);
        break;
    }
  });
})();
