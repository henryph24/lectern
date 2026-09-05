// SSRF egress guard for user-supplied import URLs.
//
// extractFromUrl fetches an arbitrary URL and returns the parsed body to the
// caller (stored, then readable), so without an egress filter it is a Server-
// Side Request Forgery primitive: cloud-metadata (169.254.169.254), loopback,
// and intranet services are all reachable, and decimal/hex IP encodings or a
// public→internal HTTP redirect bypass a naive front-door host check.
//
// This guard resolves the host and rejects any address in a private / local /
// special-use range, re-validating on EVERY redirect hop (so a redirector
// cannot launder an internal target), and caps the response size. Numeric host
// encodings (http://2130706433/, hex/octal/short forms) are canonicalized by
// the OS resolver — dns.lookup returns the real address, which we then block —
// so no brittle hand-rolled IP parser is needed.
//
// IPv6 is the one place we DO have to parse, because neither the URL parser nor
// the resolver canonicalizes an IPv4 address that is wearing an IPv6 costume:
// http://[::ffff:127.0.0.1]/ reaches us as the hostname [::ffff:7f00:1] (WHATWG
// URL rewrites v6 hosts to compressed hex, so the dotted quad never survives),
// and dns.lookup('::ffff:7f00:1') hands the same string straight back. The
// kernel, however, routes ::ffff:7f00:1 to 127.0.0.1. So ipBlocked expands a v6
// literal to its eight numeric groups and applies the IPv4 rules to whatever
// IPv4 address it embeds — text matching on the dotted form silently allowed
// loopback, IMDS and RFC1918 targets through the front door and through every
// redirect hop. The same reasoning covers every other v6 shape that carries a
// v4 destination inside it (NAT64, 6to4, IPv4-translated): the packet lands on
// that v4 host, so the v4 rules are the ones that decide (see embeddedIpv4).
//
// Residual: there is a small TOCTOU window between our lookup and the fetch's
// own connect-time resolution. Node's global fetch exposes no connect-pinning
// hook without bundling undici, and the engine's same-machine remote-trigger is
// already removed by the Host/Origin front-gate (lib/guard.js), so this guard
// targets the demonstrated vectors (literal-internal, IMDS, decimal-encoded,
// redirect-to-internal) which it closes deterministically.
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // articles are tiny; bounds a hostile body

export class BlockedAddressError extends Error {
  constructor(message = 'Refusing to fetch a private or local address') {
    super(message);
    this.name = 'BlockedAddressError';
    this.status = 400;
  }
}

function unbracket(host) {
  return host.replace(/^\[/, '').replace(/\]$/, '');
}

function ipv4Blocked(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224 && a <= 239) return true; // 224/4 multicast (e.g. 239.255.255.250 SSDP)
  if (a >= 240) return true; // 240/4 reserved, incl. 255.255.255.255 broadcast
  return false;
}

// Expand an IPv6 literal to its eight numeric 16-bit groups (null if it is not
// a valid v6 address). Every classification below is then a numeric mask test:
// the same address has many textual spellings (`::ffff:127.0.0.1`,
// `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:0001`) and only the numbers are stable.
// net.isIPv6 does the validation, so this only has to handle the two shapes it
// admits: one `::` zero-run, and an optional trailing dotted quad.
function ipv6Groups(ip) {
  if (!net.isIPv6(ip)) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const expand = (half) => {
    const out = [];
    for (const part of half ? half.split(':') : []) {
      if (part.includes('.')) {
        // A trailing dotted quad occupies the last two groups (RFC 4291 §2.2.3).
        if (!net.isIPv4(part)) return null;
        const [a, b, c, d] = part.split('.').map(Number);
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      const n = parseInt(part, 16);
      if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
      out.push(n);
    }
    return out;
  };
  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length; // groups elided by the `::` run
  if (halves.length === 2 ? fill < 0 : fill !== 0) return null;
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail];
}

// Every IPv6 shape that carries an IPv4 destination inside it. The packet ends
// up at that IPv4 host — via the local stack (mapped/compatible/translated), a
// NAT64 translator, or a 6to4 relay — so the v4 rules decide, exactly as they do
// for the dotted form. RFC 6052 §2.2 fixes which bits hold the octets for each
// prefix length. Returns every dotted quad this address could route to (empty
// for an ordinary global-unicast v6, which is then judged on the v6 rules).
function embeddedIpv4(g) {
  const quad = (...octets) => octets.join('.');
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  const low32 = () => quad(g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255);
  // ::ffff:a.b.c.d IPv4-mapped and ::a.b.c.d IPv4-compatible
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return [low32()];
  // ::ffff:0:a.b.c.d IPv4-translated (RFC 2765 ::ffff:0:0:0/96 — note the ffff
  // sits one group EARLIER than in the mapped form, which is why it needs its
  // own test rather than falling out of the one above).
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return [low32()];
  // 64:ff9b::/96 NAT64 well-known prefix (RFC 6052 §3.1 — defined only as a /96)
  if (g[0] === 0x0064 && g[1] === 0xff9b && zero(2, 6)) return [low32()];
  // 64:ff9b:1::/48 NAT64 local-use prefix (RFC 8215). The translator's operator
  // picks the prefix length, so decode both layouts a deployment can use and let
  // either internal reading block: the /48 layout (octets straddle the must-be-
  // zero u-byte at bits 64-71) and the /96 layout.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) {
    return [quad(g[3] >> 8, g[3] & 255, g[4] & 255, g[5] >> 8), low32()];
  }
  // 2002::/16 6to4 (RFC 3056): the relay's IPv4 address is groups 1-2.
  if (g[0] === 0x2002) return [quad(g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255)];
  return [];
}

function ipBlocked(ip) {
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  const v6 = unbracket(ip).toLowerCase().split('%')[0]; // drop zone id
  const groups = ipv6Groups(v6);
  // Fail closed: an address we cannot classify is not an address we can call
  // public (ipv4Blocked treats malformed input the same way).
  if (!groups) return true;
  if (groups.every((g) => g === 0)) return true; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1 loopback
  // An address that wraps an IPv4 target is judged on the v4 rules; a public
  // one (::ffff:8.8.8.8, 2002:808:808::1) falls through to the v6 rules below.
  // Compare numbers, never text — see the header note.
  if (embeddedIpv4(groups).some((v4) => ipv4Blocked(v4))) return true;
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local (fe80–febf)
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

async function assertHostAllowed(hostname) {
  const bare = unbracket(hostname);
  if (net.isIP(bare)) {
    if (ipBlocked(bare)) throw new BlockedAddressError();
    return;
  }
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new BlockedAddressError('Could not resolve host');
  }
  if (!addresses.length) throw new BlockedAddressError('Could not resolve host');
  for (const { address } of addresses) {
    if (ipBlocked(address)) throw new BlockedAddressError();
  }
}

// Like fetch(), but rejects private/local/special-use targets on the initial
// URL and every redirect hop. Returns the final Response (read it with
// readCappedText to bound the body size).
export async function safeFetch(url, { headers, signal } = {}) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new BlockedAddressError('Only http(s) URLs are supported');
    }
    await assertHostAllowed(current.hostname);
    const res = await fetch(current, { headers, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      const next = new URL(res.headers.get('location'), current);
      try {
        // Release the socket WITHOUT reading the body: MAX_RESPONSE_BYTES only
        // guards the final hop, so buffering a 3xx body here handed a hostile
        // redirector an unbounded allocation (a 302 carrying 400 MB took RSS
        // from 56 MB to 1397 MB). cancel() discards the stream instead.
        await res.body?.cancel();
      } catch {
        // ignore — an absent or already-errored body needs no release
      }
      current = next;
      continue;
    }
    return res;
  }
  throw new BlockedAddressError('Too many redirects');
}

// Read a Response body as UTF-8 text, refusing bodies larger than `max`.
export async function readCappedText(res, max = MAX_RESPONSE_BYTES) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    throw new BlockedAddressError('Response too large');
  }
  const reader = res.body?.getReader?.();
  if (!reader) return res.text();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new BlockedAddressError('Response too large');
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}
