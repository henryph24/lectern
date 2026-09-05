# Security Policy

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:
**[Security → Advisories → Report a vulnerability](../../security/advisories/new)**
on this repository. That opens a draft advisory visible only to you and the
maintainer.

Please do not open a public issue, a pull request, or a discussion for a
security report.

Include what you would need yourself: affected surface (engine, web client,
desktop app, extension), version or commit, reproduction steps, and what an
attacker gains. A proof of concept helps. There is no bounty and no SLA; this
is a personal project maintained in spare time. Reports are read and
acknowledged, and fixes ship as ordinary commits with the advisory published
once a fix is out.

## Supported versions

Only the tip of `main` is supported. Tagged releases are snapshots, and fixes
are not backported to them.

## Threat model

Lectern is a **single-user, local-first** application. Every design decision
below is deliberate, and each one is a constraint on what counts as a
vulnerability.

- **The engine is an unauthenticated HTTP server on loopback.** It binds
  `127.0.0.1:3000` (see `server/index.js`) and has no login, no session, and no
  CSRF protection; its trust boundary is the local machine, on the assumption
  that anything able to reach the port is already running as the user.
  Consequently any local process, and any web page able to make a request to
  `127.0.0.1:3000`, can read and write the library. Binding it to a routable
  interface (`HOST=…`) puts an unauthenticated file-backed API on the network,
  and is not a supported configuration.
- **Documents are stored unencrypted.** Imported text, PDFs, reading positions
  and the synthesized-audio cache live in plain files under `data/` (packaged
  desktop: `userData/data`), protected only by filesystem permissions. The
  audio cache is never pruned.
- **The macOS build is unsigned and unnotarized** (`identity: null`). It
  carries no code-signing guarantee, gets quarantined by Gatekeeper, and is
  intended for the machine that builds it. Running an unsigned build you
  downloaded means trusting whoever produced it.
- **Edge TTS is an unofficial endpoint.** The default provider talks to
  Microsoft's Edge read-aloud service through `edge-tts-universal`, keyless and
  undocumented. Text you narrate leaves the machine and is sent to that
  service. The endpoint can change or disappear without notice. Choose a
  different provider if the text is sensitive.
- **The optional ElevenLabs provider sends text to a third party** and reads
  `ELEVENLABS_API_KEY` from `.env`, which is gitignored and must stay that way.
- **The browser extension injects a MAIN-world content script into every page**
  (`http://*/*`, `https://*/*`), so it runs under the page's CSP and shares the
  page's JavaScript realm. A hostile page can see it and call into it. The
  extension therefore treats the page as untrusted: session control lives in
  the service worker, and a page-originated "read this" gesture is honored only
  against a short-lived arm that a real toolbar click created.
- **On-device model weights are third-party binaries** parsed in-process by
  `onnxruntime-node`. `scripts/fetch-supertonic.mjs` pins an immutable Hugging
  Face commit sha and verifies every file's sha256 before it is promoted into
  `data/supertonic/`. Fetching those weights by any other route skips that
  check.
- **Content you import is untrusted input.** URL and PDF extraction runs over
  attacker-controlled bytes through `jsdom`, `@mozilla/readability`, `unpdf`
  and `tesseract.js`; a parser bug reachable that way is in scope.

## In scope

- Remote code execution, path traversal, or arbitrary file read/write reachable
  through `/api/*` by an attacker whose only ability is to send requests to
  `127.0.0.1:3000`.
- A crafted URL, PDF, or pasted document that escalates beyond bad extraction:
  code execution, SSRF against non-loopback targets, resource exhaustion that
  survives the request.
- Anything that lets an ordinary web page drive the extension's session,
  exfiltrate other tabs' content, or spend a toolbar arm it did not earn.
- Leakage of `.env` secrets (`ELEVENLABS_API_KEY`, `GEMINI_API_KEY`) through an
  API response, a log, a packaged artifact, or a committed file.
- Supply-chain issues in this repository: an unpinned or unverified download, a
  release workflow that hands a write-scoped token to third-party code, a
  published artifact containing something it should not.

## Out of scope

- Anything that requires an attacker who is already executing code as the user,
  or who has filesystem access to `data/` or `.env`. That is where the trust
  boundary sits, so crossing it proves nothing.
- The absence of authentication, authorization, CSRF tokens, rate limiting, or
  transport encryption on the loopback engine, and any consequence of running
  it on a non-loopback interface.
- The macOS build being unsigned and unnotarized, and the Gatekeeper warnings
  that follow from it.
- Availability, stability, or content of the unofficial Edge TTS endpoint, and
  the fact that narrated text reaches it.
- Vulnerabilities in upstream dependencies with no exploitable path in this
  code. Report those upstream; a dependency-scanner listing on its own is not a
  report.
- Missing security headers, cookie flags, or clickjacking defenses on a
  loopback-only UI that has no authentication to protect.
- Social engineering, physical access, and anything targeting the maintainer
  rather than the software.
