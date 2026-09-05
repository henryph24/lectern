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
