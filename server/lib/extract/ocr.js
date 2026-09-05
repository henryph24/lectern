import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withTimeout } from '../semaphore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A timed-out recognize keeps running on the worker thread (the WASM call is
// uncancelable), so we cap it and tear the worker down — never let one page
// stall the whole import. Mirrors the engine's per-provider TTS timeouts.
const PAGE_TIMEOUT_MS = 30_000;

// OCR is on by default; only an explicit falsy value disables it. This is the
// escape hatch if tesseract ever misbehaves in deployment (set OCR_ENABLED=0).
export function ocrEnabled() {
  return !['0', 'false', 'no'].includes((process.env.OCR_ENABLED ?? '').trim().toLowerCase());
}

// Single language for v1. tesseract accepts '+'-joined langs ('eng+deu') but
// each one adds a traineddata download and slows recognition.
export function ocrLang() {
  return process.env.OCR_LANG || 'eng';
}

// Writable dir for the downloaded <lang>.traineddata cache. Defaults to the
// repo's data/ (matches `npm start` and dev desktop); packaged desktop sets
// OCR_CACHE_DIR to its userData path, mirroring SUPERTONIC_DIR in supertonic.js.
function cacheDir() {
  return process.env.OCR_CACHE_DIR || path.join(__dirname, '..', '..', '..', 'data', 'ocr-cache');
}

// Lazy singleton: tesseract.js (and its WASM core) load only on the first
// scanned page, and the worker is reused across pages and HTTP requests for the
// life of the process — same deferred-import idiom as supertonic.js.
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const dir = cacheDir();
      mkdirSync(dir, { recursive: true });
      const { createWorker } = await import('tesseract.js');
      return createWorker(ocrLang(), 1, { cachePath: dir }); // oem 1 = LSTM
    })();
    // Don't cache a creation failure — null it so a later page can retry.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

async function terminate() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try {
    const worker = await p;
    await worker.terminate();
  } catch {
    // worker never came up or is already gone — nothing to clean up
  }
}

// OCR one rasterized page (PNG/JPEG buffer). Returns recovered text, or '' on
// any failure — a bad page must never crash a PDF import; pdf.js treats '' as
// "still no text" and the page simply stays empty.
export async function ocrImage(imageBuffer) {
  try {
    const worker = await getWorker();
    const { data } = await withTimeout(worker.recognize(imageBuffer), PAGE_TIMEOUT_MS, 'OCR');
    return data?.text ?? '';
  } catch (err) {
    // On timeout the recognize is still burning CPU on the worker and would
    // block the next page, so discard the worker (a fresh one spins up on the
    // next call) — the analogue of "never retry an on-device timeout".
    if (err?.timeout) await terminate();
    console.warn(`[ocr] page skipped: ${err?.message ?? err}`);
    return '';
  }
}

// Tear down the worker thread so tests don't leak it between files.
export async function resetForTests() {
  await terminate();
}
