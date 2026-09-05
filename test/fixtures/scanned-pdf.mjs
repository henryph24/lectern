import { pdfWithImagePages } from './pdf-builder.mjs';

// Rasterizes text lines to an RGB bitmap (via the native @napi-rs/canvas) and
// wraps it as a text-layer-free "scanned" PDF — i.e. extractText recovers
// nothing, forcing the OCR fallback. Shared by the OCR live integration test and
// the desktop e2e (which exercises the *packaged* canvas + tesseract binaries).
export async function makeScannedPdf(lines) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const W = 1100;
  const H = 130 * lines.length + 60;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000';
  ctx.font = 'bold 56px sans-serif';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, 40, 30 + i * 130));

  const { data } = ctx.getImageData(0, 0, W, H); // RGBA
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    rgb[j++] = data[i];
    rgb[j++] = data[i + 1];
    rgb[j++] = data[i + 2];
  }
  return pdfWithImagePages([{ rgb, width: W, height: H }]);
}
