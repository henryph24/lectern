// Structural caps and normalization for content that reaches the store or the
// synchronous segmenter. The global 5 MB JSON body cap bounds raw bytes but not
// block COUNT or per-block length, so a within-5MB payload could still stall the
// single event loop in segmentDocument()'s nested loops + Intl.Segmenter — and a
// compressed PDF or a fetched page expands server-side, past any body cap at
// all. These limits sit far above any real article, so they reject abuse without
// ever tripping on legitimate documents.
export const MAX_BLOCKS = 5000;
export const MAX_BLOCK_CHARS = 50_000;
export const MAX_TOTAL_CHARS = 2_000_000;

// Returns an error message if the blocks array exceeds structural limits, else
// null. Tolerant of non-string/absent text (other validators reject those).
export function blocksOverLimit(blocks) {
  if (blocks.length > MAX_BLOCKS) return `too many blocks (max ${MAX_BLOCKS})`;
  let total = 0;
  for (const b of blocks) {
    const len = typeof b?.text === 'string' ? b.text.length : 0;
    if (len > MAX_BLOCK_CHARS) return `a block exceeds ${MAX_BLOCK_CHARS} characters`;
    total += len;
    if (total > MAX_TOTAL_CHARS) return `document exceeds ${MAX_TOTAL_CHARS} characters`;
  }
  return null;
}

// Returns an error message if a single text string is too large, else null.
export function textOverLimit(text) {
  return text.length > MAX_TOTAL_CHARS ? `text exceeds ${MAX_TOTAL_CHARS} characters` : null;
}

// Titles are caller-controlled on every import path: a page's <title> via the
// extension, Readability's title from any site, a multipart filename. They land
// in the library meta and are rendered by all three frontends. Truncation beats
// rejection here — an over-long title is never a reason to lose the import.
export const MAX_TITLE_CHARS = 300;

// The closed set of source kinds the clients render. public/js/main.js maps
// source.type through an object literal, so an unrecognized value silently falls
// through to a generic label; /import/blocks takes this straight from a live
// page, so it is normalized rather than trusted.
const SOURCE_TYPES = new Set(['url', 'pdf', 'text']);

// Trims and truncates a title to MAX_TITLE_CHARS. Non-strings pass through
// untouched — the routes reject those separately.
export function clampTitle(title) {
  if (typeof title !== 'string') return title;
  const trimmed = title.trim();
  return trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS - 1)}…` : trimmed;
}

// Coerces a caller-supplied source descriptor into {type, value} with a type
// from SOURCE_TYPES; anything unrecognized (or absent) becomes a plain 'text'
// source, mirroring how unknown block types are coerced to 'p'.
export function normalizeSource(source) {
  return {
    type: SOURCE_TYPES.has(source?.type) ? source.type : 'text',
    value: typeof source?.value === 'string' ? source.value : null,
  };
}
