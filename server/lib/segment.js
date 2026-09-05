const SOFT_LIMIT = 300;
const HARD_LIMIT = 1500;

// The leading chunks are packed smaller so the first audio synthesizes (and starts
// playing) sooner; sizes ramp back up to SOFT_LIMIT to keep the per-chunk request
// overhead low for the bulk of the document. A gentle ramp (not one tiny chunk) keeps
// the first gapless handoff safe even at high playback rates, where chunk 0's
// wall-clock duration shrinks and the prefetch margin tightens.
const FIRST_CHUNK_LIMITS = [140, 220];
const softLimitFor = (chunkIndex) => FIRST_CHUNK_LIMITS[chunkIndex] ?? SOFT_LIMIT;

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const wordSegmenter = new Intl.Segmenter('en', { granularity: 'word' });

export function segmentDocument(blocks) {
  const sentences = [];
  for (let b = 0; b < blocks.length; b++) {
    for (const s of splitSentences(blocks[b].text)) {
      sentences.push({ block: b, start: s.start, end: s.end });
    }
  }
  const chunks = packChunks(blocks, sentences);
  return { sentences, chunks };
}

export function splitSentences(text) {
  const out = [];
  for (const { segment, index } of sentenceSegmenter.segment(text)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const leading = segment.length - segment.trimStart().length;
    out.push({ start: index + leading, end: index + leading + trimmed.length });
  }
  return out;
}

function packChunks(blocks, sentences) {
  const chunks = [];
  let i = 0;
  while (i < sentences.length) {
    const first = sentences[i];
    const blockText = blocks[first.block].text;

    if (first.end - first.start > HARD_LIMIT) {
      for (const part of splitLongSentence(blockText, first.start, first.end)) {
        chunks.push(makeChunk(chunks.length, first.block, part.start, part.end, blockText, [i, i]));
      }
      i++;
      continue;
    }

    const limit = softLimitFor(chunks.length);
    let j = i;
    let end = first.end;
    while (
      j + 1 < sentences.length &&
      sentences[j + 1].block === first.block &&
      sentences[j + 1].end - first.start <= limit
    ) {
      j++;
      end = sentences[j].end;
    }
    chunks.push(makeChunk(chunks.length, first.block, first.start, end, blockText, [i, j]));
    i = j + 1;
  }
  return chunks;
}

function makeChunk(idx, block, start, end, blockText, sentenceRange) {
  return { idx, block, start, end, text: blockText.slice(start, end), sentences: sentenceRange };
}

function splitLongSentence(text, start, end) {
  const candidates = [];
  for (const { index } of wordSegmenter.segment(text.slice(start, end))) {
    if (index > 0) candidates.push(start + index);
  }
  const parts = [];
  let pieceStart = start;
  let lastCandidate = null;
  for (const cut of candidates) {
    if (cut - pieceStart > SOFT_LIMIT && lastCandidate !== null && lastCandidate > pieceStart) {
      parts.push({ start: pieceStart, end: lastCandidate });
      pieceStart = lastCandidate;
    }
    lastCandidate = cut;
  }
  if (end > pieceStart) parts.push({ start: pieceStart, end });
  return parts;
}

export const LIMITS = { SOFT_LIMIT, HARD_LIMIT, FIRST_CHUNK_LIMITS };
