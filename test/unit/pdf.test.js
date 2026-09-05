import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// OCR is mocked across this file: rendering needs the native canvas + tesseract
// WASM, which belong in the live integration test. Here we verify only the
// fallback WIRING. `extractText`/`getDocumentProxy` stay real so the fixtures
// still parse.
vi.mock('../../server/lib/extract/ocr.js', () => ({
  ocrEnabled: vi.fn(() => true),
  ocrImage: vi.fn(async () => ''),
}));
vi.mock('unpdf', async (importOriginal) => ({
  ...(await importOriginal()),
  createIsomorphicCanvasFactory: vi.fn(async () => class {}),
  renderPageAsImage: vi.fn(async () => new ArrayBuffer(8)),
}));

import {
  extractFromPdf,
  ocrRenderScale,
  pageToParagraphs,
  stripPageFurniture,
  stitchPages,
  MAX_RENDER_PIXELS,
  NoTextLayerError,
} from '../../server/lib/extract/pdf.js';
import { ocrEnabled, ocrImage } from '../../server/lib/extract/ocr.js';
import { renderPageAsImage } from 'unpdf';
import { pdfWithPages } from '../fixtures/pdf-builder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, '..', 'fixtures', name));

// A single-page PDF with a caller-chosen MediaBox and no text layer — the
// ~400-byte shape that drives the OCR render path with hostile dimensions.
// (pdf-builder.mjs hardcodes US Letter; the point here is the page size.)
function pdfWithMediaBox(width, height) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents 4 0 R >>`,
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

beforeEach(() => {
  vi.clearAllMocks();
  ocrEnabled.mockReturnValue(true);
  ocrImage.mockResolvedValue('');
  renderPageAsImage.mockResolvedValue(new ArrayBuffer(8));
});

describe('pageToParagraphs', () => {
  it('joins wrapped lines and splits on blank lines', () => {
    const page = 'First para line one\nline two ends here.\n\nSecond para.';
    expect(pageToParagraphs(page)).toEqual([
      'First para line one line two ends here.',
      'Second para.',
    ]);
  });

  it('re-joins hyphenated line breaks', () => {
    const page = 'A nicely formatted docu-\nment goes here.';
    const paras = pageToParagraphs(page);
    expect(paras.join(' ')).toContain('document goes here.');
    expect(paras.join(' ')).not.toContain('docu-');
  });

  it('ends a paragraph at a short terminal line', () => {
    const page = [
      'A long line of text that represents the typical measure of this page layout here.',
      'It ends.',
      'A new paragraph then starts on the following line of the very same page of text.',
    ].join('\n');
    const paras = pageToParagraphs(page);
    expect(paras.length).toBe(2);
    expect(paras[0].endsWith('It ends.')).toBe(true);
  });
});

describe('stripPageFurniture', () => {
  const body = (n) => `Unique body sentence number ${n} that carries the actual content of the page.`;

  it('drops headers repeating across ≥30% of pages (digit-normalized)', () => {
    const pages = Array.from({ length: 5 }, (_, p) => [
      `Journal of Studies — Issue ${p + 1}`,
      body(p * 3),
      body(p * 3 + 1),
      body(p * 3 + 2),
    ]);
    const stripped = stripPageFurniture(pages);
    const all = stripped.flat().join(' ');
    expect(all).not.toContain('Journal of Studies');
    expect(all).toContain('Unique body sentence number 0');
    expect(all).toContain('Unique body sentence number 14');
  });

  it('keeps repeated lines that are not in header/footer positions', () => {
    const refrain = 'And so the chorus came around again.';
    // refrain is the middle of five lines → outside the first-2/last-2 candidates
    const pages = Array.from({ length: 5 }, (_, p) => [
      body(p * 4),
      body(p * 4 + 1),
      refrain,
      body(p * 4 + 2),
      body(p * 4 + 3),
    ]);
    const stripped = stripPageFurniture(pages);
    expect(stripped.flat().join(' ')).toContain(refrain);
  });

  it('drops bare page numbers even in tiny documents', () => {
    const pages = [
      [body(1), body(2), '1'],
      [body(3), body(4), '- 2 -'],
    ];
    const stripped = stripPageFurniture(pages);
    const all = stripped.flat();
    expect(all).not.toContain('1');
    expect(all).not.toContain('- 2 -');
    expect(all.join(' ')).toContain('Unique body sentence number 3');
  });

  it('does not treat short repeated headers as furniture below the 3-page threshold', () => {
    const pages = [
      ['Shared Header', body(1), body(2)],
      ['Shared Header', body(3), body(4)],
    ];
    const stripped = stripPageFurniture(pages);
    expect(stripped.flat().join(' ')).toContain('Shared Header');
  });
});

describe('stitchPages', () => {
  it('merges a mid-sentence page break into one block keeping the start page', () => {
    const blocks = stitchPages([
      ['This sentence runs straight off the bottom of the page and'],
      ['finishes at the top of the next one.'],
    ]);
    expect(blocks).toEqual([
      {
        type: 'p',
        text: 'This sentence runs straight off the bottom of the page and finishes at the top of the next one.',
        page: 1,
      },
    ]);
  });

  it('re-joins hyphenated words across the page break', () => {
    const blocks = stitchPages([['The committee found the docu-'], ['ment compelling.']]);
    expect(blocks[0].text).toBe('The committee found the document compelling.');
  });

  it('does not merge when a CJK page ends a sentence', () => {
    // Without the CJK terminators every page stitches into one block, and a
    // long document then trips the per-block size cap.
    const blocks = stitchPages([['文章はここで終わります。'], ['次の段落が始まります。']]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1].page).toBe(2);
  });

  it('does not merge when the previous page ends a sentence', () => {
    const blocks = stitchPages([['A complete thought ends here.'], ['A new one starts there.']]);
    expect(blocks.length).toBe(2);
    expect(blocks[0].page).toBe(1);
    expect(blocks[1].page).toBe(2);
  });

  it('stitches across an empty page', () => {
    const blocks = stitchPages([['Interrupted by a figure-only page and'], [], ['resumed afterwards.']]);
    expect(blocks).toEqual([
      { type: 'p', text: 'Interrupted by a figure-only page and resumed afterwards.', page: 1 },
    ]);
  });
});

describe('extractFromPdf', () => {
  it('extracts paragraphs from the fixture in page order with a title block and page provenance', async () => {
    const { title, blocks } = await extractFromPdf(fixture('sample.pdf'), 'sample.pdf');
    expect(title).toBe('sample');
    expect(blocks[0]).toEqual({ type: 'h1', text: 'sample' });

    const paragraphs = blocks.slice(1);
    expect(paragraphs.length).toBe(4);
    expect(paragraphs.every((b) => b.type === 'p')).toBe(true);
    expect(paragraphs.map((b) => b.page)).toEqual([1, 1, 2, 2]);
    expect(paragraphs[0].text).toContain('a document that must be re-joined.');
    expect(paragraphs[0].text).not.toContain('docu-');
    expect(paragraphs[1].text).toContain('A second paragraph');
    expect(paragraphs[2].text).toContain('Page two');
    expect(paragraphs[3].text).toContain('trailing third paragraph');
  });

  it('strips repeated headers and page numbers end-to-end', async () => {
    const pages = Array.from({ length: 4 }, (_, p) => [
      'The Synthetic Reader — Annual Report',
      `Body paragraph for page ${p + 1} containing real narration content that must stay.`,
      `${p + 1}`,
    ]);
    const { blocks } = await extractFromPdf(pdfWithPages(pages), 'report.pdf');
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).not.toContain('Annual Report');
    expect(blocks.some((b) => /^\d+$/.test(b.text))).toBe(false);
    expect(all).toContain('Body paragraph for page 3');
  });

  it('rejects PDFs even OCR cannot recover, with an OCR-aware message', async () => {
    ocrImage.mockResolvedValue(''); // OCR recovers nothing from the blank page
    const err = await extractFromPdf(fixture('empty.pdf'), 'empty.pdf').catch((e) => e);
    expect(err).toBeInstanceOf(NoTextLayerError);
    expect(err.message).not.toContain('OCR is not supported');
    expect(ocrImage).toHaveBeenCalled(); // the OCR path was attempted
  });

  it('rejects non-PDF bytes with a 400-status error', async () => {
    await expect(extractFromPdf(Buffer.from('not a pdf at all'), 'x.pdf')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('extractFromPdf — OCR fallback wiring', () => {
  it('OCRs a page with no text layer and flows the result through the pipeline', async () => {
    ocrImage.mockResolvedValue('Recovered sentence one. Recovered sentence two.');
    const { blocks } = await extractFromPdf(fixture('empty.pdf'), 'scan.pdf');

    expect(renderPageAsImage).toHaveBeenCalledTimes(1);
    const paragraphs = blocks.filter((b) => b.type === 'p');
    expect(paragraphs.length).toBeGreaterThan(0);
    expect(paragraphs[0]).toMatchObject({ page: 1 });
    expect(blocks.map((b) => b.text).join(' ')).toContain('Recovered sentence one.');
  });

  it('only OCRs the pages that lack a text layer (mixed PDF)', async () => {
    ocrImage.mockResolvedValue('Scanned page text recovered by OCR here.');
    const mixed = pdfWithPages([
      ['A real text page with plenty of selectable words to clear the OCR threshold.'],
      [], // image-only page → must be OCR'd
    ]);
    const { blocks } = await extractFromPdf(mixed, 'mixed.pdf');

    expect(ocrImage).toHaveBeenCalledTimes(1); // page 1 skipped, page 2 OCR'd
    const all = blocks.map((b) => b.text).join(' ');
    expect(all).toContain('plenty of selectable words'); // original text layer kept
    expect(all).toContain('Scanned page text recovered by OCR'); // OCR fills the gap
    expect(blocks.find((b) => b.text.includes('Scanned page text')).page).toBe(2);
  });

  it('never touches OCR for a normal text PDF', async () => {
    await extractFromPdf(fixture('sample.pdf'), 'sample.pdf');
    expect(renderPageAsImage).not.toHaveBeenCalled();
    expect(ocrImage).not.toHaveBeenCalled();
  });

  it('does not run OCR when disabled (OCR_ENABLED off)', async () => {
    ocrEnabled.mockReturnValue(false);
    const err = await extractFromPdf(fixture('empty.pdf'), 'empty.pdf').catch((e) => e);
    expect(err).toBeInstanceOf(NoTextLayerError);
    expect(ocrImage).not.toHaveBeenCalled();
    expect(renderPageAsImage).not.toHaveBeenCalled();
  });
});

describe('ocrRenderScale', () => {
  const budget = (w, h) => w * ocrRenderScale(w, h) * (h * ocrRenderScale(w, h));

  it('leaves ordinary page sizes at the nominal 2x scale', () => {
    expect(ocrRenderScale(612, 792)).toBe(2); // US Letter
    expect(ocrRenderScale(595, 842)).toBe(2); // A4
    expect(ocrRenderScale(2384, 3370)).toBe(2); // A0 poster — 32 MP, still under budget
  });

  it('clamps a hostile MediaBox to the pixel budget', () => {
    for (const [w, h] of [
      [3600, 3600],
      [7200, 7200],
      [200_000, 200_000],
      [10, 5_000_000], // degenerate aspect ratio
    ]) {
      expect(ocrRenderScale(w, h)).toBeLessThan(2);
      expect(budget(w, h)).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1);
    }
  });

  it('falls back to the nominal scale for absent or degenerate dimensions', () => {
    expect(ocrRenderScale(0, 792)).toBe(2);
    expect(ocrRenderScale(undefined, undefined)).toBe(2);
    expect(ocrRenderScale(NaN, 100)).toBe(2);
    expect(ocrRenderScale(-612, 792)).toBe(2);
  });
});

describe('extractFromPdf — OCR render budget', () => {
  it('renders an ordinary scanned page at the full nominal scale', async () => {
    ocrImage.mockResolvedValue('Recovered sentence one. Recovered sentence two.');
    await extractFromPdf(fixture('empty.pdf'), 'scan.pdf');
    expect(renderPageAsImage.mock.calls[0][2].scale).toBe(2);
  });

  it('clamps the render of a hostile MediaBox instead of rasterizing gigapixels', async () => {
    ocrImage.mockResolvedValue('Recovered sentence from the oversized page here.');
    await extractFromPdf(pdfWithMediaBox(7200, 7200), 'bomb.pdf');

    expect(renderPageAsImage).toHaveBeenCalledTimes(1);
    const { scale } = renderPageAsImage.mock.calls[0][2];
    expect(scale).toBeLessThan(2); // 14400x14400 unclamped ≈ 2.8 GB RSS
    expect(7200 * scale * (7200 * scale)).toBeLessThanOrEqual(MAX_RENDER_PIXELS + 1);
  });

  it('stops OCR at the whole-import budget instead of one deadline per page', async () => {
    // Only Date is faked, so the real async pipeline still runs; each page
    // "costs" 100 s, so the 180 s budget is spent after two of the four pages.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      ocrImage.mockImplementation(async () => {
        vi.setSystemTime(Date.now() + 100_000);
        return 'A recovered sentence from this page of the scan.';
      });
      const { blocks } = await extractFromPdf(pdfWithPages([[], [], [], []]), 'slow-scan.pdf');

      expect(ocrImage).toHaveBeenCalledTimes(2);
      expect(renderPageAsImage).toHaveBeenCalledTimes(2);
      // partial success: what did get read is still returned
      expect(blocks.filter((b) => b.type === 'p').length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
