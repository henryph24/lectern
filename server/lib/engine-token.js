// Per-user secret that proves a process listening on the loopback port really
// is THIS user's Lectern engine.
//
// The desktop app hands the port holder everything it has: the window renders
// whatever it serves (chromeless, branded), dragged-in PDFs are POSTed to it as
// raw bytes, and the extension talks to the same fixed address. "It answered a
// GET with 200" proves nothing — any local process can bind 127.0.0.1:3000
// first and inherit all of that. So the engine writes a random 32-byte secret
// to a file only this user can read, and clients must present it.
//
// The path is deliberately independent of dataDir: `npm start` (repo ./data),
// the dev Electron shell (repo ./data) and the packaged app (userData/data)
// must all agree on ONE token, because they are interchangeable engines for the
// same user — that shared identity is what lets the desktop app reuse a running
// engine instead of starting a second one.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const TOKEN_BYTES = 32;
// Shorter than this is a truncated/garbage file, not a token we should trust.
const MIN_TOKEN_CHARS = 16;

// Resolved token → path, so repeated createApp() calls (tests boot many) do one
// filesystem round trip per path.
const cache = new Map();
let warned = false;

// The one path every Lectern engine on this machine shares.
export function engineTokenPath() {
  const home = os.homedir();
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'Lectern', 'engine.token')
    : path.join(home, '.lectern', 'engine.token');
}

function readTokenFile(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const token = raw.trim();
  if (token.length < MIN_TOKEN_CHARS) return null;
  // An existing token file with group/other bits is readable by other local
  // accounts; tighten it in place rather than rotating (rotating on every boot
  // would break the engine that is already running with the old value).
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    // best effort — an unreadable mode does not invalidate the token
  }
  return token;
}

// Read-or-create. Returns null (never throws) when the home directory is not
// writable — callers must then fail closed, since an engine with no token can
// never be authenticated.
export function ensureEngineToken(file = engineTokenPath()) {
  const cached = cache.get(file);
  if (cached) return cached;
  try {
    const existing = readTokenFile(file);
    if (existing) {
      cache.set(file, existing);
      return existing;
    }
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    try {
      // 'wx' is atomic: two engines booting at once cannot each believe they
      // authored the token.
      writeFileSync(file, token, { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const raced = readTokenFile(file);
      if (raced) {
        cache.set(file, raced);
        return raced;
      }
      // the file exists but holds nothing usable (interrupted write) — replace
      writeFileSync(file, token, { mode: 0o600 });
      chmodSync(file, 0o600); // mode is only applied on creation
    }
    cache.set(file, token);
    return token;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn(`Lectern: could not create the engine token at ${file} (${err.message}). ` +
        'Local clients that authenticate the engine (the desktop app) will refuse to reuse it.');
    }
    return null;
  }
}

// Read-only lookup for a client that wants to authenticate an engine it did not
// start. Never creates a token: minting one here would only produce a secret
// the running engine has never seen.
export function readEngineToken(file = engineTokenPath()) {
  const cached = cache.get(file);
  if (cached) return cached;
  const token = readTokenFile(file);
  if (token) cache.set(file, token);
  return token;
}
