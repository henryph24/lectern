import { extractText, getDocumentProxy, renderPageAsImage, createIsomorphicCanvasFactory } from 'unpdf';
import { normalizeWhitespace } from './blocks.js';
import { ocrEnabled, ocrImage } from './ocr.js';

const MIN_TEXT_CHARS = 40;
// Per-page OCR trigger: a page with less than this much text (after whitespace
// collapse) is treated as scanned and sent to OCR. Kept below MIN_TEXT_CHARS — a
// page bearing only a figure caption or a page number isn't a real text page
// (furniture stripping would drop those anyway).
const MIN_PAGE_OCR_CHARS = 16;
// Cap OCR work so a pathological scan can't hold an import slot for many minutes
// (~3–8 s/page). Partial success (first N pages) beats failing the whole import.
const OCR_MAX_PAGES = 50;
// A page cap alone is not a time bound: OCR_MAX_PAGES pages that each burn the
// full PAGE_TIMEOUT_MS (30 s) would pin one of the engine's two import slots for
// ~25 minutes. This budget is checked between pages — a render or a recognize
// already in flight is uncancelable — so the real bound is the budget plus one
// page. 3 minutes still covers a genuine ~25–60 page scan at 3–8 s/page.
const OCR_TOTAL_BUDGET_MS = 180_000;
// Render scale → DPI: unpdf renders 1 PDF point ≈ 1px at scale 1 (72 DPI), so
// 2.0 ≈ 144 DPI. Tesseract accuracy drops off below ~150 DPI; 2.0 balances
// accuracy against render time and memory.
const OCR_RENDER_SCALE = 2.0;
// …but the page size this multiplies is attacker-controlled: a 433-byte PDF
// declaring a 7200×7200 pt MediaBox renders a 14400×14400 canvas (measured:
// 6.2 s and 2.8 GB RSS for ONE page, then repeated OCR_MAX_PAGES times). Clamp
// the scale to a pixel budget instead of trusting the MediaBox. 40 MP is ~20× a
// US-Letter page at 2× and still above an A0 poster at 2× (32 MP), so no real
// document is ever rendered smaller than it is today.
export const MAX_RENDER_PIXELS = 40_000_000;
const __canvasImport = () => import('@napi-rs/canvas');
// Includes the CJK terminators: without them a Chinese/Japanese PDF never
// finds a paragraph end, stitches every page into one block, and trips the
// per-block size cap at roughly ten pages.
const TERMINAL_CHARS = new Set([
  '.', '!', '?', '"', '’', '”', ')',
  '。', '！', '？', '．', '」', '』', '）', '…',
]);
// header/footer candidates: only the outermost lines of a page can be furniture
const FURNITURE_DEPTH = 2;
// repetition-based stripping never touches full-width prose lines — real
// running headers/footers are short
const MAX_FURNITURE_LINE_LEN = 70;

export class NoTextLayerError extends Error {
  constructor(message = 'This PDF has no extractable text.') {
    super(message);
    this.code = 'NO_TEXT_LAYER';
    this.status = 422;
  }
}

export async function extractFromPdf(buffer, filename = 'document.pdf') {
  let pages;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    ({ text: pages } = await extractText(pdf, { mergePages: false }));
  } catch (err) {
    throw Object.assign(new Error('Could not parse this file as a PDF'), { status: 400, cause: err });
  }

  // Recover text from scanned/image-only pages via OCR before the text pipeline.
  pages = await fillScannedPages(buffer, pages);

  const pageLines = stripPageFurniture(pages.map((p) => p.split('\n').map((l) => l.trim())));
  const blocks = stitchPages(pageLines.map(linesToParagraphs));

  const totalChars = blocks.reduce((n, b) => n + b.text.length, 0);
  if (totalChars < MIN_TEXT_CHARS) {
    throw new NoTextLayerError(
      ocrEnabled()
        ? 'No readable text could be recovered from this PDF, even after OCR. It may be a blank scan or use an unsupported image format.'
        : 'This PDF has no selectable text layer (it may be a scanned document). Enable OCR to read scanned PDFs.',
    );
  }

  const title = titleFromFilename(filename);
  blocks.unshift({ type: 'h1', text: title });
  return { title, blocks };
}

// `extractText(…, {mergePages:false})` already yields per-page text. Any page
// whose text is below MIN_PAGE_OCR_CHARS is scanned/image-only — render it to an
// image and OCR it, replacing that page's string in place. The downstream
// paragraph pipeline then runs identically for scanned, mixed and text PDFs.
// Returns the (possibly mutated) `pages` array. Never throws: OCR is best-effort,
// and a page that can't be recovered simply stays empty (→ NoTextLayerError only
// if every page is empty).
async function fillScannedPages(buffer, pages) {
  if (!ocrEnabled()) return pages;

  const needing = [];
  for (let i = 0; i < pages.length; i++) {
    if (normalizeWhitespace(pages[i]).length < MIN_PAGE_OCR_CHARS) needing.push(i);
  }
  if (needing.length === 0) return pages;

  let targets = needing;
  if (targets.length > OCR_MAX_PAGES) {
    targets = targets.slice(0, OCR_MAX_PAGES);
    console.warn(`[ocr] ${needing.length} pages need OCR; capping at ${OCR_MAX_PAGES}`);
  }

  // A dedicated render proxy built WITH the canvas factory, so pdf.js can create
  // the intermediate canvases a scanned page's image XObjects need (the
  // text-extraction proxy above has none). Built lazily here — text PDFs never
  // pay for it. Fresh Uint8Array copy: pdf.js may detach the buffer it parses.
  let renderProxy;
  try {
    const CanvasFactory = await createIsomorphicCanvasFactory(__canvasImport);
    renderProxy = await getDocumentProxy(new Uint8Array(buffer), { CanvasFactory });
  } catch (err) {
    console.warn(`[ocr] renderer unavailable, skipping OCR: ${err?.message ?? err}`);
    return pages;
  }

  // Sequential: tesseract serializes on one worker anyway, and one render +
  // canvas at a time bounds peak memory.
  const deadline = Date.now() + OCR_TOTAL_BUDGET_MS;
  let attempted = 0;
  for (const i of targets) {
    if (Date.now() >= deadline) {
      console.warn(
        `[ocr] ${OCR_TOTAL_BUDGET_MS}ms budget spent after ${attempted} pages; ` +
          `${targets.length - attempted} left unread`,
      );
      break;
    }
    attempted++;
    try {
      // unpdf pages are 1-indexed; `pages` is 0-indexed.
      const png = await renderPageAsImage(renderProxy, i + 1, {
        canvasImport: __canvasImport,
        scale: await pageRenderScale(renderProxy, i + 1),
      });
      const text = await ocrImage(Buffer.from(png));
      if (text.trim()) pages[i] = text;
    } catch (err) {
      // One bad page (corrupt content, render error) must not fail the import.
      console.warn(`[ocr] page ${i + 1} failed: ${err?.message ?? err}`);
    }
  }
  return pages;
}

// The viewport pdf.js would rasterize at scale 1 (points, page rotation already
// applied) — the same figure renderPageAsImage derives internally, read here so
// the scale is clamped before any canvas is allocated.
async function pageRenderScale(proxy, pageNumber) {
  const { width, height } = (await proxy.getPage(pageNumber)).getViewport({ scale: 1 });
  return ocrRenderScale(width, height);
}

// Largest scale that keeps a widthPt × heightPt page inside MAX_RENDER_PIXELS,
// never above the nominal OCR_RENDER_SCALE. Degenerate dimensions (0, NaN, a
// missing MediaBox) fall back to the nominal scale — there is nothing to bound,
// and a NaN scale would poison the renderer.
export function ocrRenderScale(widthPt, heightPt) {
  const area = widthPt * heightPt;
  if (!Number.isFinite(area) || area <= 0) return OCR_RENDER_SCALE;
  return Math.min(OCR_RENDER_SCALE, Math.sqrt(MAX_RENDER_PIXELS / area));
}

// Drops page furniture: lines in the outermost positions of a page that either
// (a) repeat across ≥30% of pages once digits are normalized (running headers,
// "Page # of #" footers), or (b) consist of nothing but digits and joiner
// punctuation (bare page numbers). Body text is never touched because only the
// first/last FURNITURE_DEPTH non-empty lines of each page are candidates.
export function stripPageFurniture(pageLines) {
  const candidates = pageLines.map(candidateIndexes);
  const counts = new Map();
  for (let p = 0; p < pageLines.length; p++) {
    for (const i of candidates[p]) {
      const key = normalizeLine(pageLines[p][i]);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const threshold = Math.max(3, Math.ceil(pageLines.length * 0.3));
  return pageLines.map((lines, p) => {
    const drop = new Set();
    for (const i of candidates[p]) {
      const line = lines[i];
      const repeated =
        line.length <= MAX_FURNITURE_LINE_LEN &&
        (counts.get(normalizeLine(line)) ?? 0) >= threshold;
      if (isNumericFurniture(line) || repeated) {
        drop.add(i);
      }
    }
    return lines.filter((_, i) => !drop.has(i));
  });
}

function candidateIndexes(lines) {
  const nonEmpty = [];
  for (let i = 0; i < lines.length; i++) if (lines[i]) nonEmpty.push(i);
  return new Set([...nonEmpty.slice(0, FURNITURE_DEPTH), ...nonEmpty.slice(-FURNITURE_DEPTH)]);
}

function normalizeLine(line) {
  return line.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
}

const NUMERIC_FURNITURE_CHARS = new Set([...' \t-–—.·•/|()[]']);
function isNumericFurniture(line) {
  let sawDigit = false;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sawDigit = true;
    else if (!NUMERIC_FURNITURE_CHARS.has(ch)) return false;
  }
  return sawDigit;
}

// Merges a page's first paragraph into the previous page's last one when that
// one ends mid-sentence (no terminal punctuation), re-joining hyphenated words
// across the page break. Each block keeps the page it started on.
export function stitchPages(pagesOfParagraphs) {
  const blocks = [];
  pagesOfParagraphs.forEach((paragraphs, pageIdx) => {
    paragraphs.forEach((text, i) => {
      const prev = blocks.at(-1);
      if (i === 0 && prev && !TERMINAL_CHARS.has(prev.text.at(-1))) {
        prev.text =
          prev.text.endsWith('-') && startsLowercase(text)
            ? prev.text.slice(0, -1) + text
            : `${prev.text} ${text}`;
      } else {
        blocks.push({ type: 'p', text, page: pageIdx + 1 });
      }
    });
  });
  return blocks;
}

export function pageToParagraphs(pageText) {
  return linesToParagraphs(pageText.split('\n').map((l) => l.trim()));
}

// Lines arrive one per visual line. Rebuild paragraphs: re-join hyphenated
// line breaks, treat blank lines or short terminal-punctuated lines (vs page
// median width) as paragraph ends.
function linesToParagraphs(lines) {
  const lengths = lines.filter(Boolean).map((l) => l.length).sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0;

  const paragraphs = [];
  let current = '';
  const flush = () => {
    const text = normalizeWhitespace(current);
    if (text) paragraphs.push(text);
    current = '';
  };

  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    if (current.endsWith('-') && startsLowercase(line)) {
      current = current.slice(0, -1) + line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
    if (TERMINAL_CHARS.has(line.at(-1)) && line.length < median * 0.6) {
      flush();
    }
  }
  flush();
  return paragraphs;
}

function startsLowercase(line) {
  const c = line[0];
  return Boolean(c) && c.toLowerCase() === c && c.toUpperCase() !== c;
}

function titleFromFilename(name) {
  let base = name;
  const dot = base.lastIndexOf('.');
  if (dot > 0) base = base.slice(0, dot);
  return normalizeWhitespace(base.replaceAll('-', ' ').replaceAll('_', ' ')) || 'PDF document';
}
