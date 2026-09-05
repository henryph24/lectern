import { describe, it, expect } from 'vitest';
import { frontGuard } from '../../server/lib/guard.js';

// Drive the middleware directly with a fake req/res so we test the Host/Origin
// policy in isolation (the wired behavior is also asserted in routes.test.js).
function run(headers) {
  const req = { headers };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  let nexted = false;
  frontGuard()(req, res, () => {
    nexted = true;
  });
  return { res, nexted };
}

describe('frontGuard — Host allowlist (anti DNS-rebinding)', () => {
  it('allows loopback hostnames on any port', () => {
    for (const host of ['127.0.0.1:3000', 'localhost:3000', '127.0.0.1:54321', 'localhost', '[::1]:3000']) {
      const { nexted, res } = run({ host });
      expect(nexted, host).toBe(true);
      expect(res.statusCode).toBe(200);
    }
  });

  it('rejects non-loopback Host headers', () => {
    for (const host of ['evil.test', 'evil.attacker.com:3000', '169.254.169.254', '10.0.0.5:3000']) {
      const { nexted, res } = run({ host });
      expect(nexted, host).toBe(false);
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects a missing Host header', () => {
    const { nexted, res } = run({});
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe('frontGuard — Origin allowlist (anti cross-origin write)', () => {
  it('allows absent, loopback, and our own extension Origin', () => {
    const cases = [
      undefined,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'chrome-extension://mmchihfpfdagbgkmlccclgepjjhdcbfe',
    ];
    for (const origin of cases) {
      const { nexted } = run({ host: '127.0.0.1:3000', ...(origin ? { origin } : {}) });
      expect(nexted, String(origin)).toBe(true);
    }
  });

  it('rejects cross-site, opaque, and other extensions', () => {
    // Another installed extension is not a trusted client: many hold
    // <all_urls> and would otherwise read or delete the whole library.
    for (const origin of ['http://evil.test', 'https://attacker.com', 'null', 'chrome-extension://abcdef']) {
      const { nexted, res } = run({ host: '127.0.0.1:3000', origin });
      expect(nexted, origin).toBe(false);
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects an Origin-less cross-site GET (Sec-Fetch-Site), allows same-origin and direct', () => {
    for (const site of ['cross-site', 'same-site']) {
      const { nexted, res } = run({ host: '127.0.0.1:3000', 'sec-fetch-site': site });
      expect(nexted, site).toBe(false);
      expect(res.statusCode).toBe(403);
    }
    for (const site of ['same-origin', 'none', undefined]) {
      const { nexted } = run({ host: '127.0.0.1:3000', ...(site ? { 'sec-fetch-site': site } : {}) });
      expect(nexted, String(site)).toBe(true);
    }
  });
});

describe('frontGuard — security headers', () => {
  it('sets nosniff / DENY / no-referrer on every response', () => {
    const { res } = run({ host: '127.0.0.1:3000' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const csp = res.headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("media-src 'self' blob:"); // blob audio must keep playing
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
