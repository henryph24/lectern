import { describe, it, expect, afterAll } from 'vitest';
import { extractFromPdf } from '../../server/lib/extract/pdf.js';
import { resetForTests } from '../../server/lib/extract/ocr.js';
import { makeScannedPdf } from '../fixtures/scanned-pdf.mjs';

// Skip if the native canvas binary isn't available for this platform/arch — the
// OCR render path can't run without it (tesseract.js itself is pure WASM).
let canvasOk = false;
try {
  await import('@napi-rs/canvas');
  canvasOk = true;
} catch {
  console.warn('\n⚠️  OCR LIVE TEST SKIPPED — @napi-rs/canvas is not available on this platform.\n');
}

describe.skipIf(!canvasOk)('OCR — scanned PDF (real tesseract)', () => {
  afterAll(async () => {
    await resetForTests();
  });

  // First run downloads the eng traineddata and cold-starts the worker — allow time.
  it('recovers text from an image-only PDF page', async () => {
    const pdf = await makeScannedPdf([
      'The quick brown fox jumps over the lazy dog.',
      'OCR recovered this scanned line.',
    ]);
    const { blocks } = await extractFromPdf(pdf, 'scan.pdf');
    const text = blocks
      .map((b) => b.text)
      .join(' ')
      .toLowerCase();

    expect(text).toContain('quick brown fox');
    expect(text).toContain('lazy dog');
  }, 120_000);
});
