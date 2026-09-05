import { createQueue } from './queue.js';
import { createHighlighter } from './highlight.js';
import { api } from './api.js';

const RATE_KEY = 'lectern.rate';
const RATE_MIN = 0.5;
const RATE_MAX = 3;
const RATE_STEP = 0.25;
const DEFAULT_MS_PER_CHAR = 60;
const AUTOSAVE_MS = 5000;

export function createPlayer({ doc, reader, els, voice, onError }) {
  const chunks = doc.chunks;
  const sentenceToChunk = buildSentenceToChunk(doc);
  const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);

  let provider = voice.provider;
  let voiceId = voice.id;

  const audioA = new Audio();
  const audioB = new Audio();
  let active = audioA;
  let standby = audioB;
  let standbyIdx = -1;

  let cur = clampChunk(doc.position?.chunkIdx ?? 0);
  let boundIdx = -1;
  let wantPlay = false;
  let pendingTarget = { offsetMs: doc.position?.inChunkMs ?? 0, sentence: null };
  let lastSentence = -1;
  let disposed = false;
  const durations = new Map();
  let rate = clampRate(Number(localStorage.getItem(RATE_KEY)) || 1);

  let queue = makeQueue();

  const highlighter = createHighlighter({
    reader,
    onSentence: (si) => {
      lastSentence = si;
    },
  });

  /* ——— queue ——— */

  function makeQueue() {
    return createQueue({
      chunks,
      provider,
      voice: voiceId,
      onReady(idx, entry) {
        if (disposed) return;
        if (idx === cur && boundIdx !== cur) bind(entry);
        else if (idx === cur + 1) preloadStandby(idx, entry);
        updateTimes();
      },
      onError(idx, err) {
        if (disposed) return;
        if (idx === cur) {
          wantPlay = false;
          updateUI();
          onError?.(new Error(`${err.message} — press play to retry`));
        } else {
          console.warn(`Prefetch of chunk ${idx} failed`, err);
        }
      },
    });
  }

  /* ——— core playback ——— */

  function clampChunk(i) {
    return Math.max(0, Math.min(i, chunks.length - 1));
  }

  function loadChunk(idx, target = {}) {
    cur = clampChunk(idx);
    boundIdx = -1;
    pendingTarget = { offsetMs: 0, sentence: null, ...target };
    queue.ensureWindow(cur);
    const entry = queue.get(cur);
    if (entry?.status === 'ready') bind(entry);
    else updateUI();
  }

  function bind(entry) {
    boundIdx = cur;
    const chunk = chunks[cur];
    reader.activateChunk(chunk, entry.words);
    highlighter.resetWordState();

    const offsetMs = resolveOffset(entry.words, chunk);
    pendingTarget = { offsetMs: 0, sentence: null };

    active.src = entry.blobUrl;
    applyRate(active);
    active.addEventListener(
      'loadedmetadata',
      () => {
        if (disposed || boundIdx !== cur) return;
        durations.set(cur, active.duration * 1000);
        if (offsetMs > 0) active.currentTime = offsetMs / 1000;
        if (wantPlay) active.play().catch(reportPlayFailure);
        updateTimes();
      },
      { once: true },
    );
    active.load();

    const si = sentenceAtOffset(entry.words, offsetMs, chunk);
    lastSentence = si;
    highlighter.noteSentence(si);
    reader.highlightSentence(si);
    highlighter.suppressAutoScroll(1200);
    reader.scrollToSentence(si);

    maybePreloadNext();
    updateUI();
  }

  function resolveOffset(words, chunk) {
    if (pendingTarget.sentence != null) {
      const s = doc.sentences[pendingTarget.sentence];
      const w = words.find((w) => w.charStart >= 0 && chunk.start + w.charStart >= s.start);
      return w ? w.startMs : 0;
    }
    return pendingTarget.offsetMs ?? 0;
  }

  function sentenceAtOffset(words, offsetMs, chunk) {
    let wi = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].startMs <= offsetMs) wi = i;
      else break;
    }
    if (wi >= 0) {
      const w = words[wi];
      if (w.charStart >= 0) {
        const abs = chunk.start + w.charStart;
        for (let si = chunk.sentences[0]; si <= chunk.sentences[1]; si++) {
          const s = doc.sentences[si];
          if (abs >= s.start && abs < s.end) return si;
        }
      }
    }
    return chunk.sentences[0];
  }

  function maybePreloadNext() {
    const next = cur + 1;
    if (next >= chunks.length || standbyIdx === next) return;
    const entry = queue.get(next);
    if (entry?.status === 'ready') preloadStandby(next, entry);
  }

  function preloadStandby(idx, entry) {
    standby.src = entry.blobUrl;
    standby.preload = 'auto';
    applyRate(standby);
    standby.load();
    standbyIdx = idx;
  }

  function onEnded(el) {
    if (el !== active || disposed) return;
    const next = cur + 1;
    if (next >= chunks.length) {
      wantPlay = false;
      savePosition(true);
      updateUI();
      return;
    }
    const entry = queue.get(next);
    if (standbyIdx === next && entry?.status === 'ready') {
      [active, standby] = [standby, active];
      standbyIdx = -1;
      cur = next;
      boundIdx = cur;
      reader.activateChunk(chunks[cur], entry.words);
      highlighter.resetWordState();
      if (!durations.has(cur) && active.duration) durations.set(cur, active.duration * 1000);
      applyRate(active);
      if (wantPlay) active.play().catch(reportPlayFailure);
      queue.ensureWindow(cur);
      maybePreloadNext();
      updateUI();
    } else {
      loadChunk(next);
    }
  }

  audioA.addEventListener('ended', () => onEnded(audioA));
  audioB.addEventListener('ended', () => onEnded(audioB));

  function reportPlayFailure(err) {
    wantPlay = false;
    updateUI();
    onError?.(new Error(`Playback blocked: ${err.message}`));
  }

  /* ——— public controls ——— */

  function toggle() {
    if (wantPlay) {
      wantPlay = false;
      active.pause();
      savePosition();
    } else {
      wantPlay = true;
      if (boundIdx === cur && active.src) {
        active.play().catch(reportPlayFailure);
      } else {
        loadChunk(cur, pendingTarget);
      }
    }
    updateUI();
  }

  function seekToSentence(si, { autoplay = wantPlay } = {}) {
    si = Math.max(0, Math.min(si, doc.sentences.length - 1));
    const target = sentenceToChunk[si];
    wantPlay = autoplay;
    highlighter.suppressAutoScroll(1200);

    if (target === cur && boundIdx === cur) {
      const entry = queue.get(cur);
      const chunk = chunks[cur];
      const s = doc.sentences[si];
      const w = entry.words.find((w) => w.charStart >= 0 && chunk.start + w.charStart >= s.start);
      active.currentTime = (w ? w.startMs : 0) / 1000;
      highlighter.resetWordState();
      lastSentence = si;
      highlighter.noteSentence(si);
      reader.highlightSentence(si);
      reader.scrollToSentence(si);
      if (wantPlay) active.play().catch(reportPlayFailure);
    } else {
      active.pause();
      standbyIdx = -1;
      loadChunk(target, { sentence: si });
    }
    savePosition();
    updateUI();
  }

  function skip(dir) {
    const from = lastSentence >= 0 ? lastSentence : chunks[cur].sentences[0];
    seekToSentence(from + dir);
  }

  function setRate(next) {
    rate = clampRate(next);
    localStorage.setItem(RATE_KEY, String(rate));
    applyRate(audioA);
    applyRate(audioB);
    els.rateValue.textContent = `${rate}×`;
    updateTimes();
  }

  function clampRate(value) {
    const stepped = Math.round(value / RATE_STEP) * RATE_STEP;
    return Math.min(RATE_MAX, Math.max(RATE_MIN, Number(stepped.toFixed(2))));
  }

  function applyRate(el) {
    // defaultPlaybackRate must be set too: the media element load algorithm resets
    // playbackRate := defaultPlaybackRate on every resource load, so a rate set before
    // .load() (as in bind/preloadStandby) is otherwise erased back to 1×.
    el.defaultPlaybackRate = rate;
    el.playbackRate = rate;
    el.preservesPitch = true;
  }

  function setVoice(nextProvider, nextVoice) {
    if (nextProvider === provider && nextVoice === voiceId) return;
    provider = nextProvider;
    voiceId = nextVoice;
    const si = lastSentence >= 0 ? lastSentence : chunks[cur].sentences[0];
    active.pause();
    queue.dispose();
    durations.clear();
    standbyIdx = -1;
    boundIdx = -1;
    queue = makeQueue();
    loadChunk(sentenceToChunk[si], { sentence: si });
  }

  /* ——— progress & time ——— */

  function chunkMs(i) {
    if (durations.has(i)) return durations.get(i);
    return chunks[i].text.length * msPerChar();
  }

  function msPerChar() {
    let ms = 0;
    let chars = 0;
    for (const [i, d] of durations) {
      ms += d;
      chars += chunks[i].text.length;
    }
    return chars > 0 ? ms / chars : DEFAULT_MS_PER_CHAR;
  }

  function updateTimes() {
    let before = 0;
    for (let i = 0; i < cur; i++) before += chunkMs(i);
    const inChunk = boundIdx === cur ? active.currentTime * 1000 : 0;
    const elapsed = before + inChunk;
    let total = before + chunkMs(cur);
    for (let i = cur + 1; i < chunks.length; i++) total += chunkMs(i);

    const pct = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;
    els.progressFill.style.width = `${pct}%`;
    els.timeElapsed.textContent = fmt(elapsed / rate);
    els.timeRemaining.textContent = `-${fmt(Math.max(0, total - elapsed) / rate)}`;
  }

  function fmt(ms) {
    const sec = Math.round(ms / 1000);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function progressSeek(pct) {
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunkMs(i);
    let targetMs = pct * total;
    for (let i = 0; i < chunks.length; i++) {
      const d = chunkMs(i);
      if (targetMs <= d || i === chunks.length - 1) {
        active.pause();
        standbyIdx = -1;
        loadChunk(i, { offsetMs: Math.max(0, Math.min(targetMs, d - 50)) });
        return;
      }
      targetMs -= d;
    }
  }

  /* ——— persistence ——— */

  let lastSaved = 0;
  function savePosition(force = false) {
    const now = Date.now();
    if (!force && now - lastSaved < 1500) return;
    lastSaved = now;
    const inChunkMs = boundIdx === cur ? active.currentTime * 1000 : 0;
    api.savePosition(doc.id, { chunkIdx: cur, inChunkMs }).catch(() => {});
  }

  const autosave = setInterval(() => {
    if (wantPlay && boundIdx === cur) savePosition();
  }, AUTOSAVE_MS);

  const onHide = () => {
    if (document.visibilityState === 'hidden') savePosition(true);
  };
  document.addEventListener('visibilitychange', onHide);

  /* ——— UI plumbing ——— */

  function updateUI() {
    const loading = wantPlay && boundIdx !== cur;
    els.player.classList.toggle('is-loading', loading);
    els.player.classList.toggle('is-playing', wantPlay && !loading);
    els.player.classList.toggle('is-paused', !wantPlay);
  }

  const timeTicker = setInterval(() => {
    if (wantPlay) updateTimes();
  }, 250);

  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey) return;
    if (e.code === 'Space') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      skip(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      skip(1);
    } else if (e.key === '+' || e.key === '=') {
      setRate(rate + RATE_STEP);
    } else if (e.key === '-' || e.key === '_') {
      setRate(rate - RATE_STEP);
    }
  };
  document.addEventListener('keydown', onKey);

  els.btnPlay.onclick = toggle;
  els.btnPrev.onclick = () => skip(-1);
  els.btnNext.onclick = () => skip(1);
  els.rateDown.onclick = () => setRate(rate - RATE_STEP);
  els.rateUp.onclick = () => setRate(rate + RATE_STEP);
  els.progress.onclick = (e) => {
    const rect = els.progress.getBoundingClientRect();
    progressSeek((e.clientX - rect.left) / rect.width);
  };

  reader.onSentenceClick((si) => seekToSentence(si, { autoplay: true }));

  /* ——— boot ——— */

  els.playerTitle.textContent = doc.title;
  els.rateValue.textContent = `${rate}×`;
  updateUI();
  updateTimes();

  highlighter.start(() => {
    if (boundIdx !== cur) return null;
    const entry = queue.get(cur);
    if (entry?.status !== 'ready') return null;
    return { timeMs: active.currentTime * 1000, words: entry.words };
  });

  // test-only read accessor (mirrors the extension's globalThis.__lecternCore):
  // exposes the live active element's effective playback rate so the real-audio
  // e2e can assert it survives load(), which the rate UI text alone can't reveal.
  window.__lectern = {
    get activeRate() {
      return active.playbackRate;
    },
  };

  // warm the pipeline at the saved position without autoplaying
  loadChunk(cur, pendingTarget);

  return {
    toggle,
    skip,
    seekToSentence,
    setRate,
    setVoice,
    dispose() {
      disposed = true;
      savePosition(true);
      clearInterval(autosave);
      clearInterval(timeTicker);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      highlighter.stop();
      audioA.pause();
      audioB.pause();
      audioA.removeAttribute('src');
      audioB.removeAttribute('src');
      queue.dispose();
    },
  };
}

function buildSentenceToChunk(doc) {
  const map = new Array(doc.sentences.length).fill(-1);
  for (const chunk of doc.chunks) {
    for (let si = chunk.sentences[0]; si <= chunk.sentences[1]; si++) {
      if (map[si] === -1) map[si] = chunk.idx;
    }
  }
  return map.map((v) => (v === -1 ? 0 : v));
}
