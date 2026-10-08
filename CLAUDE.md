# CLAUDE.md — Lectern (speechify-clone)

Personal Speechify clone: narrates webpages/PDFs/pasted text with natural neural voices,
word-level karaoke highlighting, click-to-jump, 0.5–3× speed, resumable library.
Single user, no auth, everything local. **Three surfaces share one Express engine on :3000**:
web app (`public/`), macOS Electron app (`desktop/`), Chrome MV3 extension (`extension/`).

## Commands

```bash
npm start              # engine + web UI → http://localhost:3000
npm run desktop        # Electron shell, dev mode (uses ./data)
npm run dist:mac       # package dist/mac-arm64/Lectern.app (unsigned, arm64)
npm run test:unit      # vitest unit project (fast loop)
npm test               # unit + live integration (real Edge TTS + Wikipedia, keyless)
npm run e2e            # web app in headless Chrome (REAL audio playback)
npm run e2e:extension  # unpacked extension in headless Chrome (~80s; 35s offscreen test)
npm run e2e:desktop    # Electron via --remote-debugging-port + puppeteer.connect
npm run icons          # regenerate all icons from branding/lectern-mark-1.jpg
node scripts/generate-logo.mjs   # brand concepts via Gemini image API (.env key)
```

## Architecture

- **Engine** (`server/`, Express 5, Node ≥22, pure ESM, no build step anywhere):
  - `providers/` — TTS behind a uniform interface returning
    `{audio, format:'mp3', words:[{text,startMs,endMs,charStart,charEnd}]}`.
    `edge.js` (default, free, keyless — unofficial `edge-tts-universal`) and
    `elevenlabs.js` (active only when `ELEVENLABS_API_KEY` is in `.env`).
  - `lib/segment.js` — `Intl.Segmenter` sentences packed into ≤300-char chunks that never
    split a sentence (>1500-char sentences split at word boundaries) nor cross a block.
  - `lib/extract/` — `url.js` (Readability+jsdom), `pdf.js` (unpdf + page-furniture
    stripping + cross-page paragraph stitching + `block.page` provenance), `text.js`,
    `blocks.js` (HTML→typed blocks).
  - `lib/store.js` — `data/docs` (chunk **text is NOT stored** — re-sliced from blocks on
    read), `data/meta` (tiny library summaries), `data/positions` (autosave sidecars).
    Legacy single-file docs self-migrate on first contact.
  - `lib/cache.js` — synthesized audio at `data/cache/<sha256(provider|voice|text)>.mp3`
    + words sidecar; never pruned by design.
  - `routes/` — `docs.js` (one-shot imports `/api/docs/import/{url,pdf,text,blocks}` +
    CRUD + position), `segment.js` (pure `/api/segment` for the extension — **strict
    index parity**: rejects empty blocks instead of filtering, because callers map
    offsets back to their own block arrays), `tts.js` (cache → semaphore(2) →
    **per-provider** timeout → retry-once, but **never retry an on-device timeout**),
    `voices.js`.
- **Web client** (`public/js/`, vanilla ES modules): `player.js` dual-`<audio>` A/B swap
  for gapless chunk handoff; `queue.js` prefetch window [cur..cur+3], ≤2 concurrent,
  blob-URL LRU; `highlight.js` rAF + binary search over word timings; `reader.js` lazy
  sentence-span injection (IntersectionObserver) + caret-position click fallback, page
  markers via CSS `attr(data-page)`.
- **Desktop** (`desktop/main.mjs`): runs `createApp()` in the Electron main process.
  On `EADDRINUSE` it probes `GET /api/health` and **reuses** an existing engine (so
  `npm start` + app + extension share one library) only when that engine proves it holds
  the per-user token (`server/lib/engine-token.js`, `~/Library/Application
  Support/Lectern/engine.token`, 0600) **and** reports a version ≥ the app's. The probe
  demands a 401 anonymously *before* sending the bearer, so a squatter that answers 200
  to everything never receives the token. Packaged: data in
  `userData/data`, `.env` read from `userData/.env`. `open-file` (PDF drag-to-dock)
  queues before `ready`, imports via multipart POST, then loads `#/doc/<id>`.
- **Extension** (`extension/`, MV3): `sw.js` owns the single session
  (`chrome.storage.session`, rehydratable); `offscreen.js` plays audio (port of the dual
  audio engine; fetches :3000 directly — host_permissions bypass CORS); `content/engine.js`
  runs in the **MAIN world** (extract → ranges → `CSS.highlights` → shadow-DOM player);
  `content/extract-core.js` is the pure walker with a normalized-run offset index
  (`{normStart,len,node,nodeStart}` per text run) so server word offsets map to live DOM
  Ranges; `content/bridge.js` (isolated world) relays one-off `chrome.runtime` messages.

## Invariants & gotchas (hard-won — do not rediscover)

- **Security controls that look optional and are not.** `lib/guard.js` is the front gate:
  loopback-only `Host` allowlist (DNS rebinding), `Origin` allowlist, `Sec-Fetch-Site` for
  the Origin-less cross-site GETs a browser will not label, a strict CSP (`media-src 'self'
  blob:` is load-bearing — without it audio dies silently), and **one** allowlisted
  `chrome-extension://` id, frozen by the `key` field in `extension/manifest.json` (a
  blanket protocol match trusts every extension the user has installed). `lib/safe-fetch.js`
  blocks SSRF by expanding an IPv6 literal to its eight numeric groups and decoding every
  embedded-IPv4 form (mapped, compatible, translated, NAT64, 6to4) — never by matching the
  text of a hostname, which URL parsing rewrites out from under you. Fonts are self-hosted
  in `public/fonts/` precisely so the CSP can stay `'self'`-only.
- The SW pins a session to `sender.documentId`, never to the tab id: a tab navigates, and a
  tab-keyed session would let the next page replay the previous page's text back to itself.
  Arms carry a nonce for the same reason, and `tabs.onUpdated` drops both on a document load.
- A TTS `voice` is an id the provider publishes, checked per provider before synthesis:
  edge interpolates it into SSML unescaped, supertonic builds a file path from it.
- Edge TTS word-boundary `offset`/`duration` are **100-ns ticks** (`÷10_000` → ms); its
  output format is fixed mp3 24 kHz. Boundary text is punctuation-stripped → the
  sequential `indexOf` matcher in `lib/words.js`; unmatched words get `charStart:-1`
  (clients skip highlight, stay in sync).
- ElevenLabs: use `alignment` (original chars), never `normalizedAlignment`; fields are
  camelCase (`audioBase64`, `characterStartTimesSeconds`).
- `Intl.Segmenter` only splits sentences when the next starts uppercase, and over-splits
  after honorifics ("Dr. ") — chunk packing absorbs this; tests assert it.
- PDF furniture stripping only ever drops lines in the first/last 2 non-empty lines of a
  page AND ≤70 chars (repetition-based) — the length cap is what protects body prose that
  differs only by digits. Never weaken it.
- **Restart the dev server after adding routes** — a stale `npm start` 404s new endpoints.
  Hard-reload the browser after frontend edits (hash routing keeps stale JS alive).
- `CSS.highlights` registered from an isolated content script does NOT paint — the
  highlight controller must stay a `"world": "MAIN"` script; MAIN has no `chrome.*`, hence
  the bridge. Mutate highlights via `h.clear(); h.add(range)` — never re-register.
- MAIN-world scripts run under the **page's CSP**: Trusted Types pages (gemini.google.com,
  more Google properties over time) throw on ANY HTML-string sink, even `innerHTML = ''`.
  engine.js must build DOM via createElement/textContent only; the e2e `/tt` fixture
  enforces this (don't add a TrustedTypes policy — sites can allowlist policy names).
- SPA chrome hides from tag-based skipping: Gemini's sidebar is a custom element with
  `role="navigation"` inside `<main>` (62.8k of 63k chars). extract-core skips the ARIA
  landmark twins of SKIP_TAGS (`SKIP_ROLES`) — generalize there, never add site selectors.
- `/api/segment` can never split or drop a block (indices ARE the caller's offset→DOM map), so
  the **producer** owns the size cap: `extract-core.js` splits its own blocks at
  `MAX_BLOCK_CHARS` (50k, mirrored from `server/lib/limits.js`; unit test asserts parity),
  cutting at the last sentence boundary that fits → word boundary → hard cut. Pages that
  separate prose with `<br>` alone, or dump an article into one `<pre>`/inline container, give
  the walker no flush point at all — one 68k block, and the server 413s the whole document
  ("a block exceeds 50000 characters").
- The toolbar click is a **"read this" gesture, not play/pause**, and it is resolved **in the
  page**: `sw.js` sends mode `'auto'` and `engine.js` decides, because only it sees the live
  DOM, the selection, and the blocks the session was built from. Order: a selection wins → no
  live session reads the page → blocks that arrived since the last extraction are read *alone*
  → otherwise it asks the SW to toggle. Re-reads anchor on **DOM position**
  (`core.blocksAfter` → `locate` on the last block's last segment node), never on text: chat
  pages repeat themselves, and by the 2nd re-click the session's blocks are a tail slice
  sharing no prefix with the page. Before this, a re-click on the reading tab was hard-wired to
  `togglePlayback()`, so a new SPA answer could only be reached by reloading — which "worked"
  only by accident (`sendDown` fails mid-navigation → `stopSession()`).
- SW arms (`armedTabs`) carry a 10 s TTL. Not every trusted gesture produces a `session-start`
  (extraction can fail; an `'auto'` click can resolve to a toggle), and an unspent arm is a
  standing authorization the MAIN-world page could later spend on a forged one.
- Offscreen documents with `AUDIO_PLAYBACK` are closed by Chrome after ~30 s without
  audio (verified in e2e). Anything stateful must live in the SW session and be
  rehydratable; the server-side audio cache makes rehydration cheap.
- The extension karaoke clock (`engine.js` `tick()`) extrapolates from the last offscreen
  `time` update, and no audio plays while a chunk synthesizes (a voice switch, a slow next
  chunk). So it freezes on any state other than `playing`, and new audio for the chunk it was
  timing drops it until that audio reports its own time. A free-running clock sweeps the
  highlight through words nobody hears, and an e2e check that counts distinct words passes on
  it. A voice switch or a stop aborts every in-flight `/api/tts` fetch (offscreen `stop()`, web
  `queue.dispose()`), so the engine drops the old voice's queued requests and the new voice's
  first chunk does not wait behind them.
- The always-on engine runs as a launchd agent
  (`~/Library/LaunchAgents/dev.hungpq.lectern.engine.plist`). It **must** use
  `ProcessType=Standard` (or `Interactive`), never `Background`: on Apple Silicon
  `Background` pins the process to throttled efficiency cores, which starves
  Supertonic's on-device ONNX inference (~7–18× slower → ~22–58 s per chunk vs ~3 s)
  so it blows past the TTS synthesis timeout and the extension hangs on
  "synthesizing". Network providers (Edge) are CPU-light and unaffected — so the
  symptom is "only the on-device voice is stuck". The matching server guardrail is the
  **per-provider** timeout in `server/providers/index.js` (`timeoutMs`/`retryOnTimeout`:
  20 s + retry for network, 120 s + **no** retry-on-timeout for on-device, since a
  timed-out inference is uncancelable and a retry just races the abandoned one). The
  e2e harness runs the engine in the foreground (P-cores), so it does **not** reproduce
  this — only the launchd deployment does.
- Content scripts are classic scripts: no import/export. `extract-core.js` exports via
  `globalThis.__lecternCore` and is imported by vitest as a side-effect module.
- Branded Chrome ≥137 removed `--load-extension`; e2e loads the extension via puppeteer
  `{ pipe: true, enableExtensions: [dir] }`.
- claude-in-chrome automation tabs report `visibilityState 'hidden'`: rAF and
  IntersectionObserver never fire and media won't play. **Audio/rendering behavior is
  only verifiable via the e2e scripts**, never via that browser bridge.
- electron-builder: `identity: null` (unsigned, same-machine only), `asarUnpack:
  ["public/**"]` (asar stat-based caching is unreliable), icon auto-converted from
  `build/icon.png`. Electron's autoplay policy already allows playback — no flag needed.

## Conventions

- ESM everywhere (`"type": "module"`); no bundlers, no transpilers, no TypeScript.
- No regex for parsing/extraction — `Intl.Segmenter` for sentences/words; the few regexes
  that exist are normalization (whitespace collapse, digit-normalize) or validation.
- Every module must be wired end-to-end; remove unwired exports when touching a file.
- Tests are layered and all expected green before "done": vitest unit (mocked providers),
  live integration (real Edge TTS + real Wikipedia — keyless, always runs; ElevenLabs
  test self-skips loudly until a key exists), then the relevant e2e suite(s).
- `tasks/todo.md` tracks per-round checklists with a review section (what shipped,
  measurements, lessons). Update it as work progresses.
- `.env` is gitignored and holds `ELEVENLABS_API_KEY` (optional) and `GEMINI_API_KEY`
  (logo generation only). `data/`, `dist/`, `node_modules/` never get committed.
- Commit messages: conventional type prefix, detailed body, no attribution footers.

## Cross-platform parity (a feature isn't done until it ships on all three surfaces)

One engine, **three separate frontends**. A server change alone — or web-only wiring —
silently skips desktop and/or the extension. Before calling ANY user-facing feature
complete, wire and verify every surface:

- **Engine (shared)** — `server/`. Web and extension both consume `/api/voices` +
  `/api/tts`; desktop runs this same engine in-process. Changes here reach all three.
- **Web client** — `public/js/` (e.g. the voice picker in `public/js/main.js`).
- **Desktop** — `desktop/main.mjs` loads the web client over `http://127.0.0.1:3000`,
  so web wiring carries over; BUT a packaged `.app` bundles its own copy — `npm run
  dist:mac` when shipping, and confirm it *reuses* the running engine (the 127.0.0.1
  bind in `server/index.js` is what makes reuse fire; an IPv6 `::` bind spawns a second
  stale engine and the renderer talks to the wrong one).
- **Extension** — a SEPARATE frontend: `extension/content/engine.js` (voice picker
  `fillVoices`), `extension/sw.js`, `extension/offscreen.js`. Web changes do NOT
  propagate here — mirror them by hand.

Worked example — a **new TTS provider** must touch: `server/providers/<name>.js` +
`providers/index.js` (engine) → `server/routes/voices.js` (expose) → `public/js/main.js`
(web picker) → `extension/content/engine.js` `fillVoices` (extension picker). Forgetting
the last one is exactly how Supertonic shipped invisible to the extension.

## Verification recipe for changes

1. `npm run test:unit` → `npm test` (live).
2. **All** surface e2e (not just the one you touched — `npm run verify:all` chains the
   lot): web → `npm run e2e`; extension → `npm run e2e:extension`; desktop →
   `npm run e2e:desktop` (rebuild `dist:mac` first if packaging changed). The e2e suites
   bind :3000, so stop the always-on engine agent first
   (`launchctl bootout gui/$(id -u)/dev.hungpq.lectern.engine`) and restart it after
   (`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.hungpq.lectern.engine.plist`).
3. For UI work, also eyeball via a real browser tab (hard-reload) — and remember the
   automation-tab limitations above.
