const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

// Edge WordBoundary text arrives without surrounding punctuation, in spoken order.
// A forward-only cursor keeps duplicate words anchored to the right occurrence;
// unmatched words get charStart -1 (client skips their highlight but stays in sync).
export function edgeBoundariesToWords(boundaries, chunkText) {
  const words = [];
  let cursor = 0;
  for (const b of boundaries) {
    const idx = b.text ? chunkText.indexOf(b.text, cursor) : -1;
    if (idx === -1) {
      words.push({ text: b.text, startMs: b.startMs, endMs: b.endMs, charStart: -1, charEnd: -1 });
    } else {
      words.push({
        text: b.text,
        startMs: b.startMs,
        endMs: b.endMs,
        charStart: idx,
        charEnd: idx + b.text.length,
      });
      cursor = idx + b.text.length;
    }
  }
  return words;
}

// Supertonic (flow-matching) only reports one total clip duration — there is no
// token→frame alignment in its graph. We approximate per-word timing with a linear
// char→time map over the original chunk text: a word spanning [charStart,charEnd)
// gets [charStart/len, charEnd/len] × totalMs. Rougher than real boundaries (speech
// rate varies word to word) but monotonic, and char offsets stay exact so highlight
// + click-to-jump still anchor correctly. Chunks are ≤300 chars, so drift is bounded.
export function durationToWords(text, totalSeconds) {
  const len = text.length;
  if (!len || !(totalSeconds > 0)) return [];
  const totalMs = totalSeconds * 1000;
  const words = [];
  for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
    if (!isWordLike) continue;
    const charEnd = index + segment.length;
    words.push({
      text: segment,
      startMs: Math.round((index / len) * totalMs),
      endMs: Math.round((charEnd / len) * totalMs),
      charStart: index,
      charEnd,
    });
  }
  return words;
}

// Kokoro times whole G2P tokens: `spans` tile the text in order, each a
// [charStart, charEnd) range timed by the speech it produced ([startMs, endMs],
// or null times when it produced none). Every word-like segment of the ORIGINAL
// text takes the time of the span holding it, so char offsets are exact by
// construction. A span holding several words ("well-known") shares its time in
// proportion to their char offsets. Words in a silent span are dropped: there
// is nothing to highlight. Speech in a span with no word-like segment keeps its
// place in time with charStart -1, as edgeBoundariesToWords does.
export function spansToWords(text, spans) {
  const segments = [...wordSegmenter.segment(text)].filter((s) => s.isWordLike);
  const words = [];
  let next = 0;
  for (const span of spans) {
    const inside = [];
    while (next < segments.length && segments[next].index < span.charEnd) {
      if (segments[next].index >= span.charStart) inside.push(segments[next]);
      next++;
    }
    if (span.startMs == null) continue;
    if (!inside.length) {
      words.push({
        text: text.slice(span.charStart, span.charEnd).trim(),
        startMs: Math.round(span.startMs),
        endMs: Math.round(span.endMs),
        charStart: -1,
        charEnd: -1,
      });
      continue;
    }
    const first = inside[0].index;
    const width = inside.at(-1).index + inside.at(-1).segment.length - first;
    const at = (charOffset) => Math.round(span.startMs + ((charOffset - first) / width) * (span.endMs - span.startMs));
    for (const { segment, index } of inside) {
      const charEnd = index + segment.length;
      words.push({ text: segment, startMs: at(index), endMs: at(charEnd), charStart: index, charEnd });
    }
  }
  return words;
}

// ElevenLabs `alignment` covers the original input text char-by-char, so segment
// indices double as chunk char offsets.
export function elevenAlignmentToWords(alignment) {
  const text = alignment.characters.join('');
  const starts = alignment.characterStartTimesSeconds;
  const ends = alignment.characterEndTimesSeconds;
  const words = [];
  for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
    if (!isWordLike) continue;
    const lastChar = index + segment.length - 1;
    if (starts[index] == null || ends[lastChar] == null) continue;
    words.push({
      text: segment,
      startMs: Math.round(starts[index] * 1000),
      endMs: Math.round(ends[lastChar] * 1000),
      charStart: index,
      charEnd: index + segment.length,
    });
  }
  return words;
}
