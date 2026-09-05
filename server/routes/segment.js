import { Router } from 'express';
import { segmentDocument } from '../lib/segment.js';
import { blocksOverLimit } from '../lib/limits.js';

// Pure segmentation for clients that own their text (the Chrome extension
// reads the live DOM). No persistence. Blocks are validated strictly rather
// than filtered: dropping a block would shift indices and silently break the
// caller's offset→DOM mapping.
export function segmentRouter({ limiter } = {}) {
  const router = Router();
  const run = limiter ? (fn) => limiter.run(fn) : (fn) => fn();

  router.post('/', async (req, res, next) => {
    try {
      const { blocks } = req.body ?? {};
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return res.status(400).json({ error: 'blocks are required' });
      }
      const overLimit = blocksOverLimit(blocks);
      if (overLimit) return res.status(413).json({ error: overLimit });
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (!b || typeof b.text !== 'string' || !b.text.trim()) {
          return res.status(400).json({ error: `block ${i} has no text (blocks must not be empty — indices are significant)` });
        }
      }
      const { sentences, chunks } = await run(() => segmentDocument(blocks));
      if (chunks.length === 0) {
        return res.status(422).json({ error: 'No sentences found' });
      }
      res.json({ sentences, chunks });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
