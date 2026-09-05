import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetch, readCappedText, BlockedAddressError } from '../../server/lib/safe-fetch.js';

describe('safeFetch — SSRF egress guard', () => {
  // Literal private/local/special-use addresses are classified without DNS, so
  // these are deterministic and never touch the network.
  const blockedLiteral = [
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://10.255.255.255/',
    'http://172.16.0.1/',
    'http://172.31.255.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/', // cloud metadata (IMDS)
    'http://100.64.0.1/', // CGNAT
    'http://0.0.0.0/',
    'http://224.0.0.1/', // 224/4 multicast
    'http://239.255.255.250/', // ...SSDP, a real listener on many LANs
    'http://240.0.0.1/', // 240/4 reserved
    'http://255.255.255.255/', // ...broadcast
    'http://[::1]/', // v6 loopback
    'http://[::]/', // v6 unspecified
    'http://[fe80::1]/', // v6 link-local
    'http://[fea0::1]/', // ...still fe80::/10 — the old `startsWith('fe80')` missed this
    'http://[fd00::1]/', // v6 unique-local (fc00::/7)
  ];
  for (const url of blockedLiteral) {
    it(`blocks literal ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(BlockedAddressError);
    });
  }

  // An IPv4 address wearing an IPv6 costume. The stack routes ::ffff:7f00:1 to
  // 127.0.0.1, but no text match on the dotted quad can catch it: WHATWG URL
  // rewrites a v6 host to compressed hex — new URL('http://[::ffff:127.0.0.1]/')
  // .hostname is '[::ffff:7f00:1]' — and dns.lookup hands that string straight
  // back. Every one of these reached a real loopback/IMDS/RFC1918 target through
  // /api/docs/import/url before the guard started expanding v6 numerically.
  const blockedMappedV6 = [
    'http://[::ffff:127.0.0.1]/', // v4-mapped loopback, as the user types it
    'http://[::ffff:7f00:1]/', // ...and as it arrives after URL parsing
    'http://[::ffff:169.254.169.254]/', // v4-mapped IMDS
    'http://[::ffff:a9fe:a9fe]/', // ...post-parse
    'http://[::ffff:192.168.0.1]/', // v4-mapped RFC1918
    'http://[::7f00:1]/', // v4-COMPATIBLE loopback (::a.b.c.d, no ffff group)
  ];
  for (const url of blockedMappedV6) {
    it(`blocks IPv4-in-IPv6 ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(BlockedAddressError);
    });
  }

  // The other v6 shapes that carry an IPv4 destination. A NAT64 translator or a
  // 6to4 relay puts the packet on that IPv4 host just as surely as the local
  // stack does for ::ffff:, so the same v4 rules have to reach them.
  const blockedEmbeddedV6 = [
    'http://[64:ff9b::127.0.0.1]/', // NAT64 well-known /96 → loopback
    'http://[64:ff9b::7f00:1]/', // ...post-URL-parse
    'http://[64:ff9b::a9fe:a9fe]/', // NAT64 → IMDS
    'http://[64:ff9b::a00:1]/', // NAT64 → 10.0.0.1
    'http://[64:ff9b:1::7f00:1]/', // NAT64 local-use /48 prefix, /96 layout
    'http://[64:ff9b:1:7f00:0:100:808:808]/', // ...RFC 6052 /48 layout: 127.0.0.1 with a public low-32
    'http://[64:ff9b:1:808:0:808:7f00:1]/', // ...mirror: public /48 reading, loopback low-32
    'http://[2002:7f00:1::1]/', // 6to4 → 127.0.0.1
    'http://[2002:a9fe:a9fe::1]/', // 6to4 → IMDS
    'http://[2002:a00:1::1]/', // 6to4 → 10.0.0.1
    'http://[::ffff:0:127.0.0.1]/', // IPv4-translated (::ffff:0:0:0/96)
    'http://[::ffff:0:7f00:1]/', // ...post-URL-parse
  ];
  for (const url of blockedEmbeddedV6) {
    it(`blocks embedded-IPv4 ${url}`, async () => {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(BlockedAddressError);
    });
  }

  it('blocks decimal-encoded loopback (resolver canonicalizes 2130706433 → 127.0.0.1)', async () => {
    await expect(safeFetch('http://2130706433/')).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(safeFetch('ftp://example.com/')).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(BlockedAddressError);
  });

  // Widening the v6 rules must not turn the guard into a v6 blocklist. These
  // decode to a PUBLIC v4 (or to no v4 at all) and must still go out — proof the
  // embedded forms are decoded rather than blanket-blocked by prefix. fetch is
  // stubbed, so "allowed" is proven by the egress attempt itself, with no packet
  // actually leaving the machine.
  const allowedPublic = [
    'http://[2001:db8::1]/', // ordinary global-unicast v6
    'http://[2001:4860:4860::8888]/',
    'http://[::ffff:8.8.8.8]/', // v4-mapped, public
    'http://[64:ff9b::8.8.8.8]/', // NAT64 wrapping a public v4
    'http://[2002:808:808::1]/', // 6to4 relay at a public v4
  ];
  for (const url of allowedPublic) {
    it(`still allows ${url}`, async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      const res = await safeFetch(url);
      expect(await res.text()).toBe('ok');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(new URL(fetchSpy.mock.calls[0][0]).hostname).toBe(new URL(url).hostname);
    });
  }

  it('never reaches the network for a blocked address', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    for (const url of [...blockedLiteral, ...blockedMappedV6, ...blockedEmbeddedV6]) {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(BlockedAddressError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

describe('safeFetch — redirect hops are not buffered', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // MAX_RESPONSE_BYTES only guards the FINAL hop, so reading a 3xx body to
  // release its socket handed a hostile redirector an unbounded allocation
  // (a 302 carrying 400 MB drove RSS from 56 MB to 1397 MB). Cancelling the
  // stream frees the socket without pulling the body into memory.
  it('cancels a 3xx body rather than draining it', async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls > 64) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(1024 * 1024)); // 1 MiB per pull, 64 MiB total
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 302, headers: { location: 'http://127.0.0.1/internal' } }),
    );

    // 93.184.216.34 is public, so hop 1 passes the guard and hop 2 (loopback) is
    // refused; what this asserts is how the redirect body was disposed of.
    await expect(safeFetch('http://93.184.216.34/')).rejects.toBeInstanceOf(BlockedAddressError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(1); // draining it would have pulled all 64
  });
});

describe('readCappedText — response size cap', () => {
  it('returns bodies within the cap', async () => {
    expect(await readCappedText(new Response('hello'), 100)).toBe('hello');
  });

  it('rejects bodies that exceed the cap', async () => {
    await expect(readCappedText(new Response('hello world'), 3)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('rejects on an oversized Content-Length up front', async () => {
    const res = new Response('x', { headers: { 'content-length': '999999' } });
    await expect(readCappedText(res, 10)).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
