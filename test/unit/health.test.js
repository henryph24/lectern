import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

// The engine still has to boot when the home directory is unwritable, so the
// token resolver is mocked to the degraded case; every authenticated test below
// passes its token to createApp() explicitly instead.
const mocks = vi.hoisted(() => ({ ensureEngineToken: vi.fn(() => null) }));
vi.mock('../../server/lib/engine-token.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureEngineToken: mocks.ensureEngineToken,
}));

import { createApp } from '../../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'a'.repeat(64);

let dataDir;
let app;
let version;

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'lectern-health-'));
  app = createApp({ dataDir, engineToken: TOKEN });
  const pkg = JSON.parse(await readFile(path.join(here, '..', '..', 'package.json'), 'utf8'));
  version = pkg.version;
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /api/health — engine identity behind the engine token', () => {
  it('rejects an unauthenticated probe (any local process can bind the port)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('rejects a non-Bearer or malformed Authorization header', async () => {
    for (const header of [TOKEN, `Basic ${TOKEN}`, 'Bearer', 'Bearer   ']) {
      const res = await request(app).get('/api/health').set('Authorization', header);
      expect(res.status, header).toBe(401);
    }
  });

  it('rejects a wrong token without confirming any part of the real one', async () => {
    for (const wrong of ['b'.repeat(64), TOKEN.slice(0, 63), `${TOKEN}x`]) {
      const res = await request(app).get('/api/health').set('Authorization', `Bearer ${wrong}`);
      expect(res.status, wrong).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN.slice(0, 8));
    }
  });

  it('identifies the engine by name and version to a caller holding the token', async () => {
    const res = await request(app).get('/api/health').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'lectern', version });
  });

  it('never echoes the token, in the body or the headers', async () => {
    const res = await request(app).get('/api/health').set('Authorization', `Bearer ${TOKEN}`);
    const surface = JSON.stringify(res.body) + JSON.stringify(res.headers) + String(res.text);
    expect(surface).not.toContain(TOKEN);
  });

  it('fails closed with 503 when no token could be written (unwritable home)', async () => {
    const degraded = createApp({ dataDir });
    expect(mocks.ensureEngineToken).toHaveBeenCalled();
    const res = await request(degraded).get('/api/health').set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    // and the rest of the engine still serves
    expect((await request(degraded).get('/api/docs')).status).toBe(200);
  });

  it('is still guarded by the front gate (no reuse probe from a rebound host)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'evil.test')
      .set('Authorization', `Bearer ${TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden host' });
  });

  it('404s unknown /api routes as before', async () => {
    const res = await request(app).get('/api/health/extra');
    expect(res.status).toBe(404);
  });
});
