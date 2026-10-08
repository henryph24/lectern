import { api } from './api.js';

const WINDOW_AHEAD = 3;
const MAX_CONCURRENT = 2;
const MAX_READY = 30;

// Prefetching synth queue: keeps chunks [current .. current+3] requested with
// at most 2 in flight; ready audio lives as Blob URLs, LRU-evicted by
// distance from the playhead.
export function createQueue({ chunks, provider, voice, onReady, onError }) {
  const entries = new Map();
  let inFlight = 0;
  let focus = 0;
  let disposed = false;

  function ensureWindow(current) {
    focus = current;
    pump();
    evict();
  }

  function pump() {
    if (disposed) return;
    const last = Math.min(focus + WINDOW_AHEAD, chunks.length - 1);
    for (let idx = focus; idx <= last && inFlight < MAX_CONCURRENT; idx++) {
      const entry = entries.get(idx);
      if (entry && entry.status !== 'failed') continue;
      fetchChunk(idx);
    }
  }

  function fetchChunk(idx) {
    inFlight++;
    // dispose() aborts what is still in flight: the engine then drops an
    // abandoned request that is still waiting for a synthesis slot, so a voice
    // switch frees it for the new voice
    const entry = { status: 'fetching', abort: new AbortController() };
    entries.set(idx, entry);
    api
      .tts(provider, voice, chunks[idx].text, { signal: entry.abort.signal })
      .then(({ audioBase64, words }) => {
        if (disposed) return;
        const bytes = Uint8Array.from(atob(audioBase64), (c) => c.charCodeAt(0));
        entry.blobUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
        entry.words = words;
        entry.status = 'ready';
        onReady?.(idx, entry);
      })
      .catch((err) => {
        if (disposed) return;
        entry.status = 'failed';
        entry.error = err;
        onError?.(idx, err);
      })
      .finally(() => {
        inFlight--;
        pump();
      });
  }

  function evict() {
    const ready = [...entries.entries()].filter(([, e]) => e.status === 'ready');
    if (ready.length <= MAX_READY) return;
    ready
      .sort((a, b) => Math.abs(b[0] - focus) - Math.abs(a[0] - focus))
      .slice(0, ready.length - MAX_READY)
      .forEach(([idx, entry]) => {
        URL.revokeObjectURL(entry.blobUrl);
        entries.delete(idx);
      });
  }

  return {
    ensureWindow,
    get: (idx) => entries.get(idx) ?? null,
    dispose() {
      disposed = true;
      for (const [, entry] of entries) {
        entry.abort.abort();
        if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
      }
      entries.clear();
    },
  };
}
