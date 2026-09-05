import { Router } from 'express';
import multer from 'multer';
import { segmentDocument } from '../lib/segment.js';
import { extractFromUrl } from '../lib/extract/url.js';
import { extractFromPdf } from '../lib/extract/pdf.js';
import { textToBlocks } from '../lib/extract/text.js';
import { blocksOverLimit, clampTitle, normalizeSource, textOverLimit } from '../lib/limits.js';

// Bound the multipart parser: a single file and a tiny field-name/value budget,
// which caps the busboy field-parser DoS vector (GHSA-72gw-mp4g-v24j) even
// before the multer >=2.2.0 patch. The front-gate (lib/guard.js) already
// rejects cross-origin multipart, and the shared limiter bounds concurrency.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1, fieldNameSize: 100, fieldSize: 1024 },
});

export function docsRouter({ store, limiter }) {
  const router = Router();

  // Heavy import/segment work runs behind a shared concurrency limiter so a
  // burst of imports can't saturate the single event loop (and the CPU-bound
  // PDF/segment paths in particular).
  const run = limiter ? (fn) => limiter.run(fn) : (fn) => fn();

  // extract → segment → persist in one request; the document text never
  // round-trips through the client.
  //
  // This is the ONE structural gate for all four import routes. The caps cannot
  // live only where a client hands us blocks: /import/url and /import/pdf build
  // theirs server-side, past every body cap — a 258 KB FlateDecode'd PDF expands
  // to millions of characters. Title and source are normalized here for the same
  // reason (both are caller-controlled on at least one route).
  async function saveExtracted(res, extracted, source) {
    const overLimit = blocksOverLimit(extracted.blocks);
    if (overLimit) return res.status(413).json({ error: overLimit });
    const { sentences, chunks } = segmentDocument(extracted.blocks);
    if (chunks.length === 0) {
      return res.status(422).json({ error: 'No readable sentences found in that document' });
    }
    const doc = await store.create({
      title: clampTitle(extracted.title),
      byline: extracted.byline,
      siteName: extracted.siteName,
      source: normalizeSource(source),
      blocks: extracted.blocks,
      sentences,
      chunks,
    });
    res.status(201).json(doc);
  }

  router.post('/import/url', async (req, res, next) => {
    try {
      const { url } = req.body ?? {};
      if (!url || typeof url !== 'string' || !url.trim()) {
        return res.status(400).json({ error: 'url is required' });
      }
      await run(async () => {
        const extracted = await extractFromUrl(url.trim());
        await saveExtracted(res, extracted, { type: 'url', value: url.trim() });
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/import/pdf', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'A PDF file is required (multipart field "file")' });
      }
      await run(async () => {
        const extracted = await extractFromPdf(req.file.buffer, req.file.originalname);
        await saveExtracted(res, extracted, { type: 'pdf', value: req.file.originalname });
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/import/text', async (req, res, next) => {
    try {
      const { text, title } = req.body ?? {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text is required' });
      }
      const overLimit = textOverLimit(text);
      if (overLimit) return res.status(413).json({ error: overLimit });
      await run(async () => {
        const extracted = textToBlocks(text, typeof title === 'string' ? title : undefined);
        if (extracted.blocks.length === 0) {
          return res.status(400).json({ error: 'No readable text found' });
        }
        await saveExtracted(res, extracted, { type: 'text', value: null });
      });
    } catch (err) {
      next(err);
    }
  });

  // pre-extracted blocks from a client that read the live DOM (the extension's
  // "save to library")
  const VALID_TYPES = new Set(['h1', 'h2', 'h3', 'p', 'li', 'blockquote']);
  router.post('/import/blocks', async (req, res, next) => {
    try {
      const { title, source, blocks } = req.body ?? {};
      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ error: 'title is required' });
      }
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return res.status(400).json({ error: 'blocks are required' });
      }
      const clean = blocks
        .filter((b) => b && typeof b.text === 'string' && b.text.trim())
        .map((b) => ({ type: VALID_TYPES.has(b.type) ? b.type : 'p', text: b.text }));
      if (clean.length === 0) {
        return res.status(400).json({ error: 'No readable blocks' });
      }
      // saveExtracted owns the size cap, the title clamp and the source
      // whitelist — it sees exactly the blocks that get segmented and stored.
      await run(() => saveExtracted(res, { title, blocks: clean }, source));
    } catch (err) {
      next(err);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      res.json(await store.list());
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const doc = await store.get(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/position', async (req, res, next) => {
    try {
      const { chunkIdx, inChunkMs } = req.body ?? {};
      if (!Number.isInteger(chunkIdx) || chunkIdx < 0 || typeof inChunkMs !== 'number' || inChunkMs < 0) {
        return res.status(400).json({ error: 'position requires chunkIdx (int ≥ 0) and inChunkMs (number ≥ 0)' });
      }
      const ok = await store.setPosition(req.params.id, { chunkIdx, inChunkMs });
      if (!ok) return res.status(404).json({ error: 'Document not found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const removed = await store.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: 'Document not found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
