// Offscreen audio engine: fetches per-chunk TTS from the local Lectern server
// and plays it gaplessly (dual <audio> swap + prefetch window, mirroring the
// web app's player). Stateless by design — the service worker owns the
// session and can rehydrate this document at any position after Chrome closes
// it (30 s without audio).
const API = 'http://127.0.0.1:3000';
const WINDOW_AHEAD = 3;
const MAX_CONCURRENT = 2;
const TIME_INTERVAL_MS = 250;
// While a chunk synthesizes nothing plays and no time updates go out, so the
// player reports in at this interval instead. The service worker treats a
// longer silence as a closed player (see watchPlayer in sw.js).
const BEAT_MS = 2_000;
// A failed chunk is asked for again after this long. Retrying at once loops: a
// request to an engine that is down fails immediately, and so does every
// request from this document once Chrome starts closing it. That loop pinned
// the extension process at 100% CPU, so the closing document never finished
// closing and no new player could load.
const RETRY_MS = 2_000;

let s = null; // { chunks, provider, voice, rate, idx, wantPlay, entries, inFlight, active, standby, standbyIdx, timeTimer }

const send = (msg) => chrome.runtime.sendMessage({ target: 'sw', ...msg }).catch(() => {});

function makeAudio() {
  const el = new Audio();
  el.preservesPitch = true;
  el.addEventListener('ended', () => onEnded(el));
  return el;
}

function stop() {
  if (!s) return;
  clearInterval(s.timeTimer);
  s.active.pause();
  s.standby.pause();
  for (const [, e] of s.entries) {
    // the engine drops an abandoned request that is still waiting for a
    // synthesis slot, so a voice switch or a stop frees it at once
    e.abort.abort();
    if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
  }
  s = null;
}

function start({ chunks, startChunk = 0, offsetMs = 0, charStart = null, provider, voice, rate = 1, autoplay = true }) {
  stop();
  s = {
    chunks,
    provider,
    voice,
    rate,
    idx: Math.min(startChunk, chunks.length - 1),
    wantPlay: autoplay,
    entries: new Map(),
    inFlight: 0,
    active: makeAudio(),
    standby: makeAudio(),
    standbyIdx: -1,
    pending: { offsetMs, charStart },
    bound: false,
    lastBeat: 0,
    timeTimer: setInterval(emitTime, TIME_INTERVAL_MS),
  };
  applyRate();
  ensureWindow();
  emitState('loading');
}

function ensureWindow() {
  if (!s) return;
  const last = Math.min(s.idx + WINDOW_AHEAD, s.chunks.length - 1);
  for (let i = s.idx; i <= last && s.inFlight < MAX_CONCURRENT; i++) {
    const entry = s.entries.get(i);
    if (entry && !(entry.status === 'failed' && Date.now() >= entry.retryAt)) continue;
    fetchChunk(i);
  }
}

function fetchChunk(idx) {
  const mySession = s;
  mySession.inFlight++;
  const entry = { status: 'fetching', abort: new AbortController() };
  mySession.entries.set(idx, entry);
  fetch(`${API}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // the playback rate paces on-device synthesis, so it keeps up with the listener
    body: JSON.stringify({
      provider: mySession.provider,
      voice: mySession.voice,
      text: mySession.chunks[idx].text,
      rate: mySession.rate,
    }),
    signal: entry.abort.signal,
  })
    .then(async (res) => {
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `TTS failed (${res.status})`);
      return res.json();
    })
    .then(({ audioBase64, words }) => {
      if (s !== mySession) return;
      const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
      entry.blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
      entry.words = words;
      entry.status = 'ready';
      onReady(idx, entry);
    })
    .catch((err) => {
      if (s !== mySession) return;
      entry.status = 'failed';
      entry.retryAt = Date.now() + RETRY_MS;
      if (idx === s.idx) {
        s.wantPlay = false;
        emitState('error', err.message);
      }
    })
    .finally(() => {
      if (s !== mySession) return;
      mySession.inFlight--;
      ensureWindow();
      if (entry.status === 'failed') setTimeout(ensureWindow, RETRY_MS);
    });
}

function onReady(idx, entry) {
  if (!s) return;
  if (idx === s.idx && !s.bound) bind(entry);
  else if (idx === s.idx + 1) preload(idx, entry);
}

function bind(entry) {
  s.bound = true;
  const offset = resolveOffset(entry.words);
  s.pending = { offsetMs: 0, charStart: null };
  s.active.src = entry.blobUrl;
  applyRate();
  s.active.addEventListener(
    'loadedmetadata',
    () => {
      if (!s || !s.bound) return;
      if (offset > 0) s.active.currentTime = offset / 1000;
      if (s.wantPlay) s.active.play().catch((err) => emitState('error', `Playback failed: ${err.message}`));
    },
    { once: true },
  );
  s.active.load();
  send({ type: 'chunk-start', idx: s.idx, words: entry.words });
  emitState(s.wantPlay ? 'playing' : 'paused');
  maybePreloadNext();
}

function resolveOffset(words) {
  if (s.pending.charStart != null) {
    const w = words.find((w) => w.charStart >= 0 && w.charStart >= s.pending.charStart);
    return w ? w.startMs : 0;
  }
  return s.pending.offsetMs ?? 0;
}

function maybePreloadNext() {
  const next = s.idx + 1;
  if (next >= s.chunks.length || s.standbyIdx === next) return;
  const entry = s.entries.get(next);
  if (entry?.status === 'ready') preload(next, entry);
}

function preload(idx, entry) {
  s.standby.src = entry.blobUrl;
  applyRate(); // set defaultPlaybackRate before load() so the standby loads at the right rate
  s.standby.load();
  s.standbyIdx = idx;
}

function onEnded(el) {
  if (!s || el !== s.active) return;
  const next = s.idx + 1;
  if (next >= s.chunks.length) {
    s.wantPlay = false;
    emitState('ended');
    return;
  }
  const entry = s.entries.get(next);
  if (s.standbyIdx === next && entry?.status === 'ready') {
    [s.active, s.standby] = [s.standby, s.active];
    s.standbyIdx = -1;
    s.idx = next;
    applyRate();
    if (s.wantPlay) s.active.play().catch((err) => emitState('error', err.message));
    send({ type: 'chunk-start', idx: s.idx, words: entry.words });
    ensureWindow();
    maybePreloadNext();
  } else {
    goTo(next, { offsetMs: 0 });
  }
}

function goTo(idx, pending) {
  s.idx = Math.max(0, Math.min(idx, s.chunks.length - 1));
  s.bound = false;
  s.standbyIdx = -1;
  s.pending = { offsetMs: 0, charStart: null, ...pending };
  s.active.pause();
  ensureWindow();
  const entry = s.entries.get(s.idx);
  if (entry?.status === 'ready') bind(entry);
  else emitState('loading');
}

function applyRate() {
  if (!s) return;
  // defaultPlaybackRate must be set too: the media element load algorithm resets
  // playbackRate := defaultPlaybackRate on every resource load, so a rate set before
  // .load() (as in bind/preload) is otherwise erased back to 1×.
  for (const el of [s.active, s.standby]) {
    el.defaultPlaybackRate = s.rate;
    el.playbackRate = s.rate;
    el.preservesPitch = true;
  }
}

function emitTime() {
  if (!s) return;
  if (!s.bound) {
    // Nothing plays while the chunk synthesizes. Tell the service worker the
    // player is still here (which also keeps it awake), so it can tell this
    // wait from a player Chrome closed.
    if (s.wantPlay && Date.now() - s.lastBeat >= BEAT_MS) {
      s.lastBeat = Date.now();
      send({ type: 'waiting' });
    }
    return;
  }
  send({
    type: 'time',
    idx: s.idx,
    ms: s.active.currentTime * 1000,
    rate: s.rate,
    playing: s.wantPlay && !s.active.paused,
  });
}

function emitState(state, message) {
  send({ type: 'state', state, message, idx: s?.idx ?? 0, rate: s?.rate ?? 1 });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  // Only extension contexts (the service worker) speak this protocol; a
  // content script has sender.tab set and must never drive playback.
  if (sender?.tab !== undefined) return;
  if (!msg || msg.target !== 'offscreen') return;
  switch (msg.type) {
    case 'start':
      start(msg.payload);
      break;
    case 'toggle':
      if (!s) break;
      if (s.wantPlay) {
        s.wantPlay = false;
        s.active.pause();
        emitState('paused');
      } else {
        s.wantPlay = true;
        if (s.bound) s.active.play().catch((err) => emitState('error', err.message));
        else ensureWindow();
        emitState('playing');
      }
      break;
    case 'seek':
      if (s) {
        s.wantPlay = true;
        goTo(msg.chunkIdx, { charStart: msg.charStart ?? null, offsetMs: msg.offsetMs ?? 0 });
      }
      break;
    case 'rate':
      if (s) {
        s.rate = msg.value;
        applyRate();
        emitState(s.wantPlay ? 'playing' : 'paused');
      }
      break;
    case 'voice': {
      if (!s) break;
      const pos = { startChunk: s.idx, offsetMs: 0, provider: msg.provider, voice: msg.voice };
      start({ chunks: s.chunks, rate: s.rate, autoplay: s.wantPlay, ...pos });
      break;
    }
    case 'stop':
      stop();
      break;
  }
});
