import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { ttsRouter } from './routes/tts.js';
import { voicesRouter } from './routes/voices.js';
import { docsRouter } from './routes/docs.js';
import { segmentRouter } from './routes/segment.js';
import { healthRouter } from './routes/health.js';
import { createCache } from './lib/cache.js';
import { createStore } from './lib/store.js';
import { frontGuard } from './lib/guard.js';
import { createSemaphore } from './lib/semaphore.js';
import { ensureEngineToken } from './lib/engine-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ dataDir = path.join(__dirname, '..', 'data'), allowedHosts, engineToken } = {}) {
  const app = express();
  // Boot-time identity: one per-user secret shared by every Lectern engine on
  // this machine, so a local client can tell this engine from any other process
  // that happens to hold the port. null when the home dir is unwritable — the
  // engine still serves, /api/health just fails closed.
  const token = engineToken ?? ensureEngineToken();
  const cache = createCache(path.join(dataDir, 'cache'));
  const store = createStore(dataDir);
  // Bounds concurrent CPU/IO-heavy import + segment work across the engine.
  const importLimiter = createSemaphore(2);

  // First line of defense: reject non-loopback Host headers (DNS rebinding) and
  // cross-origin writes, and set security headers — before any route, body
  // parse, or static asset. See lib/guard.js.
  app.use(frontGuard(allowedHosts ? { allowedHosts } : {}));

  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use('/api/tts', ttsRouter({ cache }));
  app.use('/api/voices', voicesRouter);
  app.use('/api/docs', docsRouter({ store, limiter: importLimiter }));
  app.use('/api/segment', segmentRouter({ limiter: importLimiter }));
  app.use('/api/health', healthRouter({ token }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message });
    }
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    const body = { error: err.message || 'Internal error' };
    if (err.code) body.code = err.code;
    if (err.suggestPasteText) body.suggestPasteText = true;
    res.status(status).json(body);
  });

  return app;
}
