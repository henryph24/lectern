import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { engineTokenPath, ensureEngineToken } from '../../server/lib/engine-token.js';

let dir;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lectern-token-'));
});

afterEach(async () => {
  // some cases make a directory read-only — restore before removing
  await chmod(dir, 0o700).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

// a fresh module instance defeats the in-process token cache, so the test sees
// what a *second* engine booting on this machine would see
async function freshModule() {
  vi.resetModules();
  return import('../../server/lib/engine-token.js');
}

describe('engineTokenPath — one per-user path, independent of dataDir', () => {
  it('is the Application Support file on darwin', () => {
    expect(withPlatform('darwin', engineTokenPath)).toBe(
      path.join(homedir(), 'Library', 'Application Support', 'Lectern', 'engine.token'),
    );
  });

  it('is the dotfile everywhere else', () => {
    for (const platform of ['linux', 'win32']) {
      expect(withPlatform(platform, engineTokenPath)).toBe(
        path.join(homedir(), '.lectern', 'engine.token'),
      );
    }
  });

  it('lives under the user home, never under a data directory', () => {
    const file = engineTokenPath();
    expect(file.startsWith(homedir() + path.sep)).toBe(true);
    expect(path.basename(file)).toBe('engine.token');
  });
});

describe('ensureEngineToken', () => {
  it('creates a 32-byte hex token with mode 0600 in a 0700 directory', async () => {
    const file = path.join(dir, 'Lectern', 'engine.token');
    const token = ensureEngineToken(file);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(file, 'utf8')).toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('reuses an existing token instead of rotating it on every boot', async () => {
    const file = path.join(dir, 'engine.token');
    const first = ensureEngineToken(file);

    const { ensureEngineToken: ensureAgain } = await freshModule();
    const second = ensureAgain(file);

    expect(second).toBe(first);
    expect(await readFile(file, 'utf8')).toBe(first);
  });

  it('tightens the mode of a token file left world-readable', async () => {
    const file = path.join(dir, 'engine.token');
    await writeFile(file, 'a'.repeat(64), { mode: 0o644 });
    await chmod(file, 0o644);

    const { ensureEngineToken: ensureFresh } = await freshModule();
    expect(ensureFresh(file)).toBe('a'.repeat(64));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('replaces a truncated/garbage token file', async () => {
    const file = path.join(dir, 'engine.token');
    await writeFile(file, '  \n');

    const { ensureEngineToken: ensureFresh } = await freshModule();
    const token = ensureFresh(file);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('degrades to null (never throws) when the home directory is unwritable', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    const home = path.join(dir, 'readonly-home');
    await mkdir(home);
    await chmod(home, 0o500);

    const { ensureEngineToken: ensureFresh } = await freshModule();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(ensureFresh(path.join(home, 'Lectern', 'engine.token'))).toBe(null);
    warn.mockRestore();
  });
});

describe('readEngineToken', () => {
  it('returns null and creates nothing when no engine has ever booted', async () => {
    const file = path.join(dir, 'engine.token');
    const { readEngineToken: readFresh } = await freshModule();

    expect(readFresh(file)).toBe(null);
    await expect(stat(file)).rejects.toThrow();
  });

  it('reads the token an engine wrote', async () => {
    const file = path.join(dir, 'engine.token');
    const token = ensureEngineToken(file);

    const { readEngineToken: readFresh } = await freshModule();
    expect(readFresh(file)).toBe(token);
  });
});
