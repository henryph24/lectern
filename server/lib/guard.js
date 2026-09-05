// Front-line access control for the always-on local engine.
//
// The engine binds loopback only, but a browser on the same machine will still
// issue requests to 127.0.0.1 on behalf of ANY site the user visits. The two
// real threats that loopback binding does NOT stop are:
//   • DNS rebinding — a hostile site rebinds its own name to 127.0.0.1 and the
//     browser sends Host: evil.test (the name the user navigated to). Because
//     the document origin then equals the resolved target, the request is
//     "same-origin" and responses are fully readable. The defense is a Host
//     allowlist: legitimate clients only ever send a loopback HOSTNAME
//     (127.0.0.1 / localhost / ::1); a rebound request carries the attacker's
//     hostname and is rejected. The PORT is not a boundary (the attacker uses
//     the real one), so the check is hostname-based and port-agnostic — which
//     also lets tests run on an ephemeral port.
//   • Cross-origin simple-request writes — e.g. multipart/form-data is
//     CORS-safelisted, so a cross-site form/fetch reaches a write route with no
//     preflight. The defense is an Origin allowlist on any request that carries
//     an Origin header.
//
// The Host check is the load-bearing control (GET reads carry no Origin); the
// Origin check covers preflight-free cross-origin writes. Browsers omit Origin
// on cross-site GETs, so those are covered by Sec-Fetch-Site, which browsers do
// send: anything a *site* initiated ('cross-site' / 'same-site') is rejected,
// while a genuine same-origin request or a direct navigation ('none') passes.
//
// The extension is a trusted first-party client that talks to the engine under
// host_permissions, so its origin is allowed — but only its own origin. A
// blanket chrome-extension: pass would trust every extension the user has
// installed (many hold <all_urls>), and one of those could read or delete the
// whole library. The id is fixed by the "key" field in extension/manifest.json,
// so it is the same for an unpacked load and for a packed build; override it
// with LECTERN_EXTENSION_ID when loading a differently-keyed development copy.
const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1'];
const EXTENSION_ID = process.env.LECTERN_EXTENSION_ID || 'mmchihfpfdagbgkmlccclgepjjhdcbfe';

// Same-origin fetches from the app itself, plus blob: audio the player builds
// from /api/tts bytes. No third-party origin is reachable, so a hostile
// document that ever reached an HTML sink still could not phone home.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// Extract the bare hostname from a Host header: "name", "name:port", "[::1]",
// or "[::1]:port" → "name" / "::1".
function hostnameOfHost(host) {
  if (!host) return null;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? null : host.slice(1, end);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function unbracket(hostname) {
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

export function frontGuard({ allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));

  const hostOk = (hostHeader) => {
    const name = hostnameOfHost(hostHeader);
    return name != null && allowed.has(unbracket(name).toLowerCase());
  };

  const originOk = (origin) => {
    if (!origin) return true; // no Origin → not a cross-origin browser write
    if (origin === 'null') return false; // opaque origin (sandboxed frame, data:)
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol === 'chrome-extension:') return url.hostname === EXTENSION_ID;
    return allowed.has(unbracket(url.hostname).toLowerCase());
  };

  // Origin-less cross-site requests (an <img src> or a top-level GET from a
  // hostile page) carry Sec-Fetch-Site instead. 'none' is a direct navigation
  // or an extension/native client; 'same-origin' is the app itself. Anything
  // else was initiated by another site.
  const fetchSiteOk = (site) => site == null || site === 'none' || site === 'same-origin';

  return function frontGuardMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);

    if (!hostOk(req.headers.host)) {
      return res.status(403).json({ error: 'Forbidden host' });
    }
    if (!originOk(req.headers.origin)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    // Only consulted when there is no Origin to judge; a request that carries
    // one has already passed the allowlist above (the extension sends its own).
    if (!req.headers.origin && !fetchSiteOk(req.headers['sec-fetch-site'])) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    next();
  };
}
