import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Identity endpoint for local clients that must decide whether the process on
// the loopback port is a Lectern engine they can trust with the library, the
// window and dragged-in files (see lib/engine-token.js).
//
// It answers ONLY to a caller that already knows this user's engine token, and
// it answers with two facts: the name (so a look-alike server cannot pass by
// returning 200 to any GET) and the version (so a client can refuse to hand
// itself to an engine that predates its own security fixes — an unversioned
// engine could keep an old, unpatched build permanently in charge of the port).
//
// The token is never echoed back: a client that guesses wrong learns only that
// it guessed wrong.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readVersion() {
  try {
    // package.json ships next to server/ in the repo and inside the asar, so
    // this resolves identically for `npm start`, dev Electron and the app.
    const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
  } catch {
    // fall through — an unreadable package.json must not stop the engine
  }
  return '0.0.0';
}

export const ENGINE_NAME = 'lectern';
export const ENGINE_VERSION = readVersion();

// "Bearer <token>" → "<token>"; anything else → null.
function bearerOf(header) {
  if (typeof header !== 'string') return null;
  const space = header.indexOf(' ');
  if (space === -1) return null;
  if (header.slice(0, space).toLowerCase() !== 'bearer') return null;
  const value = header.slice(space + 1).trim();
  return value.length > 0 ? value : null;
}

function secretsMatch(presented, expected) {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

export function healthRouter({ token, version = ENGINE_VERSION } = {}) {
  const router = Router();

  router.get('/', (req, res) => {
    // No token on disk → nothing can authenticate → fail closed rather than
    // advertising an engine no client can verify.
    if (!token) return res.status(503).json({ error: 'Engine token unavailable' });

    const presented = bearerOf(req.headers.authorization);
    if (!presented) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!secretsMatch(presented, token)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ name: ENGINE_NAME, version });
  });

  return router;
}
