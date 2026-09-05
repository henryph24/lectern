import { pdfWithImagePages } from './pdf-builder.mjs';

// Rasterizes text lines to an RGB bitmap (via the native @napi-rs/canvas) and
// wraps it as a text-layer-free "scanned" PDF — i.e. extractText recovers
// nothing, forcing the OCR fallback. Shared by the OCR live integration test and
// the desktop e2e (which exercises the *packaged* canvas + tesseract binaries).
const FONT = 'bold 56px sans-serif';
const MARGIN = 40;
const LINE_HEIGHT = 130;

export async function makeScannedPdf(lines) {
  const { createCanvas } = await import('@napi-rs/canvas');
  // Measure with the real font before sizing the bitmap. "sans-serif" resolves
  // to a different face per platform (the Linux CI fallback is wider than the
  // macOS one), so a fixed width clips the longest line on some machines and the
  // OCR test then fails on text that was never drawn.
  const measure = createCanvas(8, 8).getContext('2d');
  measure.font = FONT;
  const widest = Math.max(...lines.map((line) => measure.measureText(line).width));
  const W = Math.ceil(widest) + MARGIN * 2;
  const H = LINE_HEIGHT * lines.length + 60;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';
  ctx.font = FONT;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, MARGIN, 30 + i * LINE_HEIGHT));

  const { data } = ctx.getImageData(0, 0, W, H); // RGBA
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    rgb[j++] = data[i];
    rgb[j++] = data[i + 1];
    rgb[j++] = data[i + 2];
  }
  return pdfWithImagePages([{ rgb, width: W, height: H }]);
}
