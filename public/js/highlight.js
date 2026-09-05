// rAF-driven karaoke loop. audio.currentTime is a media-timeline position, so
// playbackRate needs no compensation here.
export function createHighlighter({ reader, onSentence }) {
  let raf = 0;
  let getFrame = null;
  let lastWordIdx = -1;
  let lastSentence = -1;
  let lastUserScrollAt = 0;
  let programmaticUntil = 0;

  const markUserScroll = () => {
    if (performance.now() > programmaticUntil) lastUserScrollAt = performance.now();
  };
  window.addEventListener('wheel', markUserScroll, { passive: true });
  window.addEventListener('touchmove', markUserScroll, { passive: true });

  function tick() {
    raf = requestAnimationFrame(tick);
    const frame = getFrame?.();
    if (!frame) return;
    const { timeMs, words } = frame;
    if (!words?.length) return;

    const wi = lastWordAtOrBefore(words, timeMs);
    if (wi === lastWordIdx) return;
    lastWordIdx = wi;
    if (wi < 0) return;

    const si = reader.highlightWord(wi);
    if (si >= 0 && si !== lastSentence) {
      lastSentence = si;
      reader.highlightSentence(si);
      onSentence?.(si);
      if (performance.now() - lastUserScrollAt > 3000) {
        programmaticUntil = performance.now() + 1000;
        reader.scrollToSentence(si);
      }
    }
  }

  function lastWordAtOrBefore(words, timeMs) {
    let lo = 0;
    let hi = words.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].startMs <= timeMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  return {
    start(frameSource) {
      getFrame = frameSource;
      lastWordIdx = -1;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      getFrame = null;
    },
    resetWordState() {
      lastWordIdx = -1;
    },
    noteSentence(si) {
      lastSentence = si;
    },
    suppressAutoScroll(ms = 1000) {
      programmaticUntil = performance.now() + ms;
    },
  };
}
