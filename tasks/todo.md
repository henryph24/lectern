# Speechify Clone — Build Checklist

## Round 11 (2026-09-24): Kokoro-82M on-device provider with per-phoneme word timing

Goal: add Kokoro-82M v1.0 (Apache-2.0, ONNX) as a fourth TTS provider behind the same
`{audio, format:'mp3', words}` contract, on all three surfaces. Supertonic reports one duration
per clip, so its word timings are proportional; Kokoro reports one duration per phoneme token,
so every word gets a measured timestamp. G2P comes from HeadTTS (MIT) with a CMUdict-derived
dictionary, which keeps eSpeak and GPL code out of the dependency tree.

- [x] `scripts/fetch-kokoro.mjs` + npm `fetch:kokoro`: 12 files (~333 MB) pinned to immutable
      revisions with a sha256 each; streaming hash, promote on match, re-hash on skip, `--force`,
      startup failure on an unpinned file. Destination `data/kokoro` or `$KOKORO_DIR`.
- [x] Vendor the HeadTTS G2P byte for byte → `server/providers/kokoro/` (MIT header + LICENSE)
- [x] `server/providers/kokoro.js`: closed voice allowlist (hasOwnProperty) before any path is
      built; lazy onnxruntime import; cached session, dictionary, vocabulary, voice tables;
      failed loads retried; 510-token context split at sentence, then word boundaries
- [x] `server/lib/words.js`: `spansToWords` (timed G2P spans → words, char offsets in the
      original chunk text via Intl.Segmenter)
- [x] Register in `providers/index.js` (120 s, no retry on timeout) + `routes/voices.js`
- [x] Web picker (`public/js/main.js`) + extension picker (`extension/content/engine.js`)
- [x] Self-skipping Kokoro checks in the web, extension and desktop e2e suites
- [x] Unit tests (mocked onnxruntime, real G2P on a tiny dictionary) + live test on the model
- [x] README (setup, privacy table, limitations, licensing) + SECURITY.md (pinned weights)
- [ ] e2e suites run (not run this round: they bind :3000)

### Round-11 review / lessons

**Verification**: 278 passed, 1 skipped (ElevenLabs: no `.env` on this machine), up from 229
passed, 1 skipped. The Kokoro live test ran against the real weights (2/2). Real-model probes:
all 9 voices synthesize (14/14 words each); 10 edge inputs (punctuation only, a lone dash,
emoji, a 30-digit number, a URL, curly quotes, accents, a newline, an 835-char sentence) all
produce in-order timings that slice back to their words; two concurrent cold calls return
audio byte-identical to sequential calls. Fetch script: re-run verifies 12/12 by re-hash, a
wrong digest leaves no file behind, an unpinned file fails before any download.

**Adversarial review** (Opus, fresh context) found 1 major, 3 minor, 1 nit, all reproduced:
- Fixed (major): numbers below 1e-6 or with 309+ digits overflowed the stack in the vendored
  number reader, so the chunk failed on every retry. A subclass now reads written numbers
  digit for digit. Fuzz, 6000 generated inputs: the vendored G2P alone threw on 380 and spoke
  "undefined" on 127; through the provider, 0 and 0.
- Fixed: punctuation-only chunks reached the model, which ended "…" in a 0.100 RMS burst;
  they now play 300 ms of silence.
- Documented: "10-20" is read as "ten minus twenty" (vendored G2P).
- Left for a follow-up (shared with Supertonic): onnxruntime-node runs inference synchronously
  on the main thread; the event loop froze for 3094 ms of a 3095 ms synthesis.
- Added: tests for a shared first load, a retried failed load and a malformed voice file
  (each killed its mutant).

**Measurements** (M3 Pro, CPU, fp32): model load 0.63 s warm / 2.30 s cold; RTF median 0.200
on a 296-char chunk (3.83 s for 19.10 s of audio); engine RSS +789 to +842 MB after the first
synthesis (Supertonic: +696 MB). Turning off the onnxruntime CPU arena raised RSS (2041 MB
after a 500-token run, against 980 MB with the default), so the defaults stay.

**Lessons**:
- `durations` holds the predictor's floats before rounding; the decoder renders
  max(1, round-half-even(d)) frames of 600 samples per token. When those rounded frames sum to
  the waveform length (every probe so far), they give sample-exact word edges; stretching the
  floats over the real audio length is the fallback.
- The HeadTTS G2P drops every character it has no rule for, U+2019 included, so "we’re" was
  read as "were" and "I’ll" as "ill". Swap such characters one-for-one before G2P so char
  offsets stay valid in the original text.
- "Nothing to voice" means no token other than a space: "日本 語" leaves one space token, and
  the first guard (empty token list) let it through to a 768-byte, near-empty mp3. A failing
  test caught it. Pauses alone are also nothing to voice (the model fills them with noise), so
  the guard now asks for a speech token.
- The vendored reader round-trips written digits through a double; `String(1e-8)` has no '.',
  and its decimal branch recursed on the same string forever. Read numbers from the written
  text, and fuzz a vendored parser before trusting it.

**Follow-ups (not done)**: run `npm run verify:all` (stop the launchd engine agent first);
move on-device inference to a worker thread, and stop a timed-out chunk between pieces; in the
desktop and extension e2e voice switches (Supertonic and Kokoro), the previous voice's word
can count as one of the two highlights;
the packaged desktop sets neither `SUPERTONIC_DIR` nor `KOKORO_DIR`, so both on-device
providers stay unavailable in a packaged app that starts its own engine (pre-existing, Round 6);
the American-English dictionary serves the British voices too, "Dr." is read as "drive", and
text outside the Latin alphabet is skipped.

## Round 10 — extension re-click never re-read an SPA (2026-08-24) — DONE

On claude.ai (or any SPA) the first toolbar click read the answer fine, but a follow-up answer
was unreachable without a full page reload. Root cause: `chrome.action.onClicked` was hard-wired
to `togglePlayback()` whenever the clicked tab already owned the session, so the icon was a
transport control and never a re-read; nothing invalidates a session when the SPA swaps in new
DOM. The reload "fix" was an accident — the SW's next `sendDown` into the navigating tab throws
and its `.catch` calls `stopSession()`, so the following click fell into the fresh-session
branch.

- [x] **Resolve the click in the page** (`engine.js`): `sw.js` now sends mode `'auto'`; only the
      engine sees the live DOM, the selection, and the session's blocks. Order — a non-collapsed
      selection wins → no live session (first click, or the page reloaded under a session the SW
      still holds) reads the page → blocks that arrived since the last extraction are read alone
      → otherwise `up({type:'control', action:'toggle'})`. `hasSession` rides down with `begin`
      so the engine never resolves to a toggle the SW would drop (a dead click).
- [x] **`core.blocksAfter(prev, fresh)`** (`extract-core.js`): anchors on **DOM position** —
      `locate()` on the last block's last segment node — returning the blocks after it, `[]` when
      nothing is new, `null` when the anchor is detached (page re-rendered → re-read whole).
      Anchoring on the *last* block rather than diffing a prefix is what makes the 2nd/3rd
      re-click work, where `live.blocks` is itself a tail slice sharing no prefix with the page.
- [x] **`live.bounded`**: a selection-derived session is mid-page by definition, so "everything
      after it" is the rest of the article, not new content — those toggle instead.
- [x] **`activate(tabId, mode)`** (`sw.js`): one entry point for the icon and both context menus;
      when the tab can't take content scripts it falls back to controlling the session we still
      own there, so a click is never silently a no-op. `flashBadge('✕')` moved out of
      `beginSession` to here.
- [x] **Arm TTL** (`sw.js`): `armedTabs` Set → Map with a 10 s expiry. An `'auto'` click that
      resolves to a toggle (like an extraction error before it) produces no `session-start`, so
      arms have to expire rather than leave a standing authorization for a forged one.
- [x] **Instant handoff** (`sw.js onSessionStart`): stop live offscreen playback before
      re-segmenting, so a re-read silences the old narration immediately.
- [x] **Tests**: 7 new unit (`extract-core.test.js`) over an SPA-thread jsdom — nothing new → `[]`,
      appended turn → only that, 2nd/3rd re-read off a tail slice, verbatim text repeat still
      counts as new (DOM anchor, not text), mid-thread insert before the anchor ignored, detached
      anchor → `null`, empty prev → `null`. 4 new extension e2e checks driving `__lecternStart('auto')`
      (the same path as a toolbar click).

### Round-10 review / lessons

- Verified: unit 152 ✓; `npm test` 158 + 1 skip ✓; extension e2e **28/28** (was 24 checks);
  web e2e 13/13; desktop e2e 7/7. Engine agent stopped for the runs and restored after
  (health 200).
- New e2e evidence: unchanged page → status "Paused", block count unchanged at 13 (no
  re-extraction); one `<p>` appended to `<article>` → session rebuilt to **1 block** with the
  karaoke highlight inside `#spa-answer`; a selection over the blockquote → highlight on
  "Listening".
- Desktop e2e failed twice mid-session (Supertonic 1 word, then even the Edge karaoke check)
  and passed 7/7 on a third run with the machine idle — on-device inference is timing-sensitive
  under load. The change is extension-only (`git diff --stat`: `extension/**` + `test/**`), and
  the packaged `.app` bundles no extension files, so it cannot be causal.
- Lesson: a gesture that can resolve more than one way must resolve where the information is.
  The SW cannot see the DOM or the selection, so any "did the page change?" logic there would
  have been a heuristic; in the page it is one `locate()` call against nodes it already holds.
- Flagged, not fixed: no auto-follow — new content is picked up on the next click only, by
  design. A `MutationObserver` in the engine could offer "keep reading as answers arrive".

## Round 9 — oversized blocks 413 the whole page (2026-08-24) — DONE

Reading some pages failed with `a block exceeds 50000 characters`. Root cause: the extension
walker (`extension/content/extract-core.js`) only flushes a block at blockish/typed elements, so
a page whose prose lives in one container with no block-level children — `<br>`-separated
articles, a whole article in one `<pre>`, all-inline SPA containers — collapses into a single
block of arbitrary length. `/api/segment` then rejects the ENTIRE document (413), because it may
not split or drop blocks: block indices are the caller's offset→DOM mapping (strict index
parity). The producer is therefore the only place the cap can live.

- [x] **Cap in the walker** (`extract-core.js`): `flush()` now pushes `capBlock(current)`, which
      splits an over-long block into ≤`MAX_BLOCK_CHARS` (50k, mirroring `server/lib/limits.js`)
      pieces — cutting at the last **sentence** boundary that fits, falling back to a **word**
      boundary inside an over-long sentence, then a hard cut for an unbroken 50k token. Separator
      spaces (which belong to no run) are never left dangling on either side of a cut.
      `Intl.Segmenter`s are built lazily — this script loads on every page.
- [x] **`sliceBlock(block, start, end)`**: one rebase/clip helper for the normalized-run index, so
      split pieces still resolve to live DOM Ranges. `sliceFromCaret` now reuses it (its
      hand-rolled rebase loop is gone).
- [x] **Tests** (`test/unit/extract-core.test.js`, 6 new): server-cap parity, `<br>`-only article
      → server-accepted blocks cut on sentence boundaries, every word of a split block still maps
      back to an identical Range, word-boundary fallback (no word ever split, 12k words
      preserved), unbroken-token hard cut (content byte-identical), and normal pages untouched.

### Round-9 review / lessons

- Verified: unit 145 ✓; `npm test` 151 + 1 skip ✓; web e2e 13/13; extension e2e 23/23; desktop
  e2e 7/7. Engine agent stopped for the runs and restored after (health 200).
- Repro before the fix (jsdom): an 80-paragraph `<br>`-separated article → **1 block, 68,159
  chars** → `blocksOverLimit` says "a block exceeds 50000 characters". After: 2 blocks, max
  49,983, accepted.
- The cap belongs to the producer, not the route: anything that "fixes" this server-side would
  have to renumber blocks and would silently break the extension's highlight mapping.
- Flagged, not fixed: (a) server-side extractors (`lib/extract/{url,pdf,text}.js` → import/url,
  import/pdf) never run `blocksOverLimit`, so they can persist an equally oversized block — no
  user-visible failure today, since `segmentDocument` handles long blocks; (b) `sw.js validUp`
  *silently* drops a `session-start` carrying >5000 blocks (`MAX_UP_BLOCKS`) — nothing plays and
  no error is shown.

## Round 8 — movable extension player bar (2026-08-12) — DONE

The extension's floating player (shadow-DOM bar in `extension/content/engine.js`) was pinned
bottom-center; on pages like Gemini it covers the page's own footer UI. It is now draggable.
Extension-only by design: web/desktop use the docked in-page player, so there is no bar to move
on those surfaces — parity satisfied by omission.

- [x] **Drag** (`extension/content/engine.js`): pointer events on `.bar` — pointerdown on any
      non-control area (`closest('button, select')` excluded) + `setPointerCapture`; a 3 px
      threshold so plain clicks never reposition; first real move pins the host to px `left/top`
      inline styles (they beat the `:host` centered rule), clamped ≥8 px inside the viewport.
      `barPos` module state survives close/reopen for the page's life; `resize` re-clamps.
      Trusted-Types-safe (no HTML sinks touched) and MAIN-world-safe (no `chrome.*`).
- [x] **CSS**: `.bar` gets `cursor: grab` / `.dragging` → `grabbing`, `user-select: none`,
      `touch-action: none`; buttons/select keep their own `pointer` cursor.
- [x] **e2e** (`test/e2e/extension.e2e.mjs`): three new real-mouse checks — exact-drag by the
      status area, mouse-down-on-control never drags, off-screen drag clamps inside the viewport
      (bar parks top-right, clear of the click-to-jump target).

### Round-8 review / lessons

- Verified: unit 139 ✓; `npm test` 145 + 1 skip ✓; web e2e 13/13; extension e2e 23/23 (3 new);
  desktop e2e 7/7. Engine agent stopped for the runs and restored after (health 200).
- The extension e2e page is puppeteer's default 800×600 viewport (`--window-size` ≠ viewport, no
  `setViewport` in that suite) — the first drag assertion hit the clamp; drag deltas in that suite
  must stay inside ~800×600.
- Desktop e2e flake, pre-existing: `desktop.e2e.mjs` kills Electron with SIGTERM then checks
  `child.killed` — which is true once a signal is *delivered*, not when the process dies — so the
  SIGKILL fallback never fires; a wedged app survives, holds :9557, and breaks the next run with
  "bind() failed: Address already in use". Flagged, not fixed (out of scope this round).

## Round 7 — OCR for scanned PDFs (2026-06-21) — DONE

Scanned/image-only PDFs (no text layer) used to hard-fail with a 422 "OCR is not supported".
The PDF extractor now falls back to OCR per page, so scanned and mixed PDFs become readable on
web + desktop. The extension can't import PDFs (Chrome's PDF viewer has no DOM to inject into —
`sw.js` returns false for PDFs), so it's intentionally untouched — parity is satisfied by omission.

- [x] **OCR module** (`server/lib/extract/ocr.js`): lazy tesseract.js worker (loads only on the
      first scanned page, reused process-wide — the deferred-import idiom from supertonic.js),
      `ocrImage(buf)` with a 30 s per-page `withTimeout` + terminate-on-timeout (the WASM recognize
      is uncancelable — analogue of "never retry an on-device timeout"), graceful-empty on any
      failure. `OCR_ENABLED`/`OCR_LANG`/`OCR_CACHE_DIR` env (defaults: on / eng / data/ocr-cache).
- [x] **Per-page fallback** (`server/lib/extract/pdf.js` `fillScannedPages`): `extractText(…,
      {mergePages:false})` already yields per-page text; any page < 16 chars is rendered
      (`unpdf.renderPageAsImage` @ scale 2 ≈ 144 DPI, via a render proxy built WITH the canvas
      factory) and OCR'd, replacing that page in place. The existing
      stripPageFurniture→linesToParagraphs→stitchPages pipeline and the 40-char NoTextLayerError
      gate run unchanged → the gate now fires only if even OCR recovers nothing. Capped at 50 pages.
- [x] **Deps + packaging**: add `tesseract.js` + `@napi-rs/canvas` (was only unpdf's optional peer);
      `asarUnpack` += canvas / tesseract.js / tesseract.js-core (canvas `.node` auto-unpacks like
      onnxruntime-node; tesseract WASM+worker don't, so they're listed). `desktop/main.mjs` sets
      `OCR_CACHE_DIR` to a writable userData dir (the asar is read-only).
- [x] **Fixtures + tests**: Buffer-based `pdfWithImagePages` (raw RGB + zlib FlateDecode XObject —
      lossless, deterministic, no committed binary) + shared `makeScannedPdf` (canvas-rasterized
      known text). Unit (mocked OCR): per-page wiring, mixed PDF, no-regression, disabled path.
      Integration (real tesseract): recovers "quick brown fox" from an image-only PDF. Desktop e2e:
      OCRs a scanned PDF through the PACKAGED engine.

### Round-7 review / lessons

- Verified: unit **145 passed | 1 skipped**; live `npm test` green incl. the new real-tesseract
  integration test; desktop e2e **7/7** (incl. packaged OCR → 201); web e2e **13/13** (no
  regression); packaged binaries load from `app.asar.unpacked` (canvas draws, tesseract
  createWorker); always-on launchd engine confirmed OCRing a scanned PDF end-to-end.
- The render proxy MUST carry the canvas factory: `renderPageAsImage(proxy)` uses the proxy as-is
  (short-circuits re-parse on `_pdfInfo`), so the `extractText` proxy (no CanvasFactory) can't paint
  a scanned page's image XObjects. A dedicated render proxy is built lazily — text PDFs never pay
  for canvas init, and OCR is never even imported for them.
- `renderPageAsImage` needs `@napi-rs/canvas` but NOT `pdfjs-dist` — it works with unpdf's bundled
  serverless PDF.js build (an earlier research claim that it requires the official build was wrong;
  the dist falls back to the serverless build via `resolvePDFJSImport`).
- Env gotcha during e2e: an unrelated `clever-fx` Vite server squats on IPv6 `[::1]:3000`;
  `localhost` resolves to IPv6 first, so the web e2e must target `127.0.0.1` (IPv4) — Lectern binds
  IPv4, so the two coexist without conflict.

## Round 6 — fundamental security hardening (2026-06-19) — DONE

Multi-agent audit (27 findings → 10 refuted → 17 confirmed) found two root causes; fixed both
plus the targeted issues on the surfaces they expose. "No auth" stays by-design — every fix
targets a real attacker (malicious site hitting the localhost engine, hostile imported content,
or a hostile page abusing the extension).

- [x] **Fix 1 — engine front-gate** (`server/lib/guard.js`, mounted first in `app.js`): Host
      allowlist (loopback hostnames only, port-agnostic) defeats DNS rebinding incl. GET reads;
      Origin allowlist (loopback + `chrome-extension:`) blocks the CORS-simple multipart write;
      `X-Frame-Options: DENY` + `nosniff` + `Referrer-Policy`. Closes #1, #8.
- [x] **Fix 2 — extension SW gesture/ownership gate** (`extension/sw.js`, `bridge.js`): only a tab
      armed by a trusted gesture (`beginSession`) may `session-start`; `voice`/`rate` now require a
      tab-owned session; `validUp()` shape/bounds check drops forged/oversized messages. (The
      audit's "nonce handshake" is unsound — the page shares the MAIN world; the SW gate needs no
      unforgeable page channel.) Closes #2.
- [x] **Fix 3 — SSRF egress guard** (`server/lib/safe-fetch.js` → `extract/url.js`): resolve +
      reject loopback/RFC1918/link-local(IMDS)/CGNAT/IPv6 ranges, re-validate every redirect hop
      (manual redirects), cap response bytes. Decimal/hex host encodings canonicalized by the
      resolver. Closes #3.
- [x] **Fix 4 — shared limiter + caps + multer** (`app.js` `importLimiter`, `lib/limits.js`,
      `routes/docs.js`+`segment.js`, multer `^2.2.0` + `fieldNameSize`/`fieldSize`/`files` limits):
      bounds import/segment concurrency and block/char counts; field-size limits neutralize the
      busboy field-parser DoS independent of multer version. Closes #4, #6, #7.
- [x] **Fix 5 — Supertonic voice allowlist** (`providers/supertonic.js` `isKnownVoice`): validate
      the id against the closed `VOICE_META` set (hasOwnProperty) before any path is built; generic
      error, no path echo. Closes the `voice='../../../x'` traversal oracle. Closes #5.
- [x] Deferred (defense-in-depth, refuted-as-exploitable): Electron nav guards, strict CSP,
      confirm-on-delete, prototype-pollution sweep, PDF-parser fuzzing.

### Round-6 review / lessons

- Verified: unit **135/135** (+new guard/safe-fetch/limits/supertonic suites); live `npm test`
  **140 pass / 1 skip** (real Wikipedia through `safeFetch`, real Edge TTS); `npm audit` **0 vulns**;
  web e2e **13/13**, extension e2e **20/20** (incl. 3 adversarial forged-message checks), desktop
  e2e **6/6** (packaged bundle). Live curl: rebinding `403`, cross-origin write `403`, SSRF→IMDS
  `400`, headers present.
- **Host allowlist must be hostname-based, not authority(host:port)-based** — legit clients use the
  configured port AND so does a rebinding attacker, so the port is not a boundary; the hostname is
  the rebinding signal. Authority-with-port also breaks supertest's ephemeral port.
- **macOS `localhost` resolves to IPv6 `::1` first.** The web e2e defaults to `localhost:3000`;
  an unrelated dev server on `[::1]:3000` shadowed Lectern (IPv4 `127.0.0.1:3000`). Run web e2e with
  `APP_URL=http://127.0.0.1:3000`. (Engine binds IPv4 loopback by design — see `server/index.js`.)
- **`electron-builder` rewrites `node_modules/<dep>/package.json` on disk during its rebuild step**
  (saw multer reverted 2.2.0→2.1.1 while the lockfile stayed 2.2.0; `npm install` won't correct it
  because npm believes it's already satisfied). Fix with `rm -rf node_modules/multer && npm install`.
  Also: `npx asar extract-file` writes the extracted file to the CWD basename — it clobbered the
  repo `package.json`; never run it from the repo root.

## Round 5 — extension dead on Trusted Types pages (2026-06-12) — DONE

- [x] Root cause: gemini.google.com sends `require-trusted-types-for 'script'`; engine.js runs
      in the MAIN world (page CSP applies), so `bar.innerHTML = …` in mountUi() threw before
      anything rendered — both the normal AND the error path mount the bar, hence click → nothing.
- [x] Fix: build the player bar with createElement only (`el()` helper); fillVoices
      `innerHTML = ''` → `replaceChildren()`. No TrustedTypes policy — sites can allowlist
      policy names, DOM building works everywhere.
- [x] Regression: e2e fixture server now serves `/tt` (same article + TT CSP header); asserts
      TT actually enforces, player mounts, karaoke paints. 16/16 green.
- [x] Second bug behind the first: Gemini's `<main>` wraps the whole app — sidebar is
      `bard-sidenav[role=navigation]` (62.8k of 63k chars). extract-core now skips ARIA
      landmark twins of SKIP_TAGS (navigation/banner/contentinfo/complementary/dialog/
      alertdialog/form/search). Verified on live Gemini DOM: welcome page 603 blocks →
      3; a real conversation extracts as "You said / … / Gemini said / …", no sidebar leak.
- [x] Node 24 actions migration complete: checkout/setup-node v6, cache v5,
      upload-artifact v7, download-artifact v8, gh-release v3. Verified by push CI AND a
      real tag build: v1.0.1 released (app 126 MB + extension zip), desktop e2e run 5/5
      against the downloaded release binary via LECTERN_APP.

### Round-5 review / lessons

1. MAIN-world content scripts run under the *page's* CSP — Trusted Types blocks every
   HTML-string sink (innerHTML/outerHTML/insertAdjacentHTML), even `innerHTML = ''`.
   Google properties increasingly enforce it. createElement/textContent only.
2. Without the "tabs" permission, `chrome.tabs.query` returns tabs with `url` undefined —
   exact-URL tab matching in the SW silently finds nothing (why the e2e hook's active-tab
   fallback exists; bringToFront() + the hook is the deterministic way to target a tab).
3. Tag-based chrome skipping is blind on SPAs: they use `role=` landmarks on divs/custom
   elements. Skip the role twins of the skip-tags, not site-specific selectors.
4. CI-only e2e flake: navigating the fixture page before the extension finishes loading
   leaves it without content scripts, and the SW cannot inject into it (hook calls grant
   no activeTab; the random fixture port has no host permission) — silent 15s mount
   timeout. Wait for the SW target BEFORE page.goto; beginSession now returns success so
   the hook throws a descriptive error (round-4 "fail loudly" pattern).
5. actions/checkout + setup-node bumped v4 → v6 (Node 24; the forced-node24 cutoff is
   2026-06-16). upload/download-artifact@v4 + gh-release@v2 left on purpose: tag-build
   only, unflagged, and their current majors change artifact path semantics — bump them
   with the next release where the macOS tag build verifies them.

## Round 4 — CI/CD (2026-06-11) — DONE

- [x] ci.yml: unit + live integration job; e2e job (web/extension/desktop on ubuntu) — green
- [x] release.yml: v* tags → unit gate → macOS arm64 Lectern.app zip + extension zip → GitHub Release
- [x] v1.0.0 published: Lectern-1.0.0-arm64-mac.zip (120 MB) + lectern-extension-v1.0.0.zip

### Round-4 review / lessons (5 CI iterations to green)

1. Lockfile drift: incremental `npm install <pkg>` on macOS omitted deps of linux-only
   optional packages → `npm ci` failed on runners. Fix: full lock regeneration; verify
   with `npm ci --dry-run` before pushing workflows.
2. puppeteer hit-test clicks flake on animated fixed elements (player bar slides in
   350ms) and inside Electron-under-xvfb — drive UI via DOM dispatch in e2e.
3. npm Electron has no SUID sandbox helper and Ubuntu 24 runners restrict user
   namespaces → ELECTRON_DISABLE_SANDBOX=1 for the CI step.
4. `npm version <same>` errors ("Version not changed") → --allow-same-version.
5. electron-builder auto-publishes on CI tag builds (wants GH_TOKEN) → --publish never;
   let the release job own uploads.
6. Edge TTS works fine from GitHub datacenter IPs (live integration green every run).
7. Re-tagging flow for workflow fixes: tag must contain the fixed workflow —
   delete + recreate the tag (`git push origin :refs/tags/vX`).
8. macOS runners bill 10× minutes on private repos — tags only, not per-commit.
9. Post-green flake (~40%): chrome.tabs.query({active, lastFocusedWindow}) returns
   nothing when headless CI windows report no focus — the e2e hook silently no-op'd.
   Never gate on window focus in headless; fail loudly instead of returning null.
   Verified dead with 3 consecutive green runs (p≈0.22 under the old failure rate).

## Round 3 — macOS desktop app + Chrome extension (approved 2026-06-11)

- [x] Server: POST /api/segment (pure, index-parity validation) + POST /api/docs/import/blocks + supertest cases
- [x] scripts/make-icons.mjs → extension icons (16/32/48/128) + build/icon.png (1024)
- [x] extension/content/extract-core.js (walker + normalized-run offset index + selection/caret modes) + 10 jsdom round-trip tests vs real segmentDocument
- [x] Manifest (MAIN-world engine + isolated bridge via one-off messages — no port, SW detects dead tabs on failed push)
- [x] offscreen.js + sw.js: toolbar click → extract → segment → TTS → gapless audio
- [x] Highlight controller (CSS Custom Highlight API, clear+add, rAF extrapolation) + auto-scroll
- [x] Floating shadow-DOM player (voice/rate/skip/save-to-library) + context menus (caret capture) + ⌘⇧1 command
- [x] Lifecycle: storage.session state, offscreen rehydration after 30s-pause close, multi-tab/nav teardown
- [x] test/e2e/extension.e2e.mjs — 12/12 (incl. real 35s offscreen-shutdown + rehydration assertion)
- [x] desktop/main.mjs (boot-or-reuse engine, open-file PDF queue, window) — dev mode verified
- [x] electron-builder dist:mac → packaged .app verified standalone (own engine, fresh userData, asar statics, live voices)
- [x] test/e2e/desktop.e2e.mjs — 5/5 against the packaged app + README

### Round-3 review

All four suites green: 82 unit/integration (+1 ElevenLabs skip awaiting key), web e2e 9/9,
extension e2e 12/12, desktop e2e 5/5. Packaged Lectern.app is 316 MB (Electron 42), boots its
own engine from the asar with userData storage, reuses an existing :3000 engine when present
(so desktop + web dev + extension share one library), imports PDFs dropped on the dock.
Extension reads live DOM in place with zero page mutation (CSS Custom Highlight API from a
MAIN-world content script), survives offscreen-document shutdown during long pauses via
SW-owned session state, and saves pages into the shared library.

Lessons:
- A long-running dev server silently lacks routes added later — restart before debugging
  "404 from new endpoint" (cost a diagnostic cycle on /api/segment).
- Branded Chrome ≥137 removed --load-extension; puppeteer `pipe: true` +
  `enableExtensions: [dir]` is the working replacement (verified in puppeteer-core 25.1 types).
- CSS.highlights set in an isolated world doesn't paint — the highlight controller must be a
  "world": "MAIN" content script, with chrome.* access relayed through an isolated bridge.
- Chrome really does close AUDIO_PLAYBACK offscreen docs after ~30 s without audio (e2e
  observes it); any MV3 audio app needs SW-owned, rehydratable session state.

## Round 2 — large-PDF improvements (approved 2026-06-11)

- [x] Extract reusable PDF builder for tests (test/fixtures/pdf-builder.mjs)
- [x] Page-furniture stripping: repeated header/footer lines (digit-normalized, candidate positions only, ≤70-char guard so prose is never stripped) + bare page-number lines
- [x] Cross-page paragraph stitching (mid-sentence page breaks merge, hyphen re-join, works across empty pages) + tests
- [x] Page provenance on PDF blocks (block.page)
- [x] One-shot imports: POST /api/docs/import/{url,pdf,text} replaced /api/extract/* and the raw POST /api/docs; byline/siteName now persisted
- [x] chunk.text no longer stored (hydrated on read); meta + position sidecars; library list reads 185-byte summaries; legacy docs self-heal on first contact
- [x] Frontend: api.js import calls; p.N margin markers (CSS attr(data-page) — survives span rewrites); Contents jump panel (headings, else pages); lazy sentence-span injection via IntersectionObserver + caret-offset click fallback + reader.dispose
- [x] Tests: 65 unit (was 56) + 3 live integration green
- [x] e2e 9/9 (added TOC-hidden check); benchmark re-run
- [x] README/data-layout updated

### Round-2 review

400-page benchmark, before → after: header lines narrated 400× → **0**; bare page-number
blocks 400 → **0**; stored doc 1.31 MB → **0.79 MB**; library list now reads a 185-byte meta
file per doc instead of the full document; position autosave writes a ~90-byte sidecar instead
of rewriting 0.79 MB every 5 s; one-shot import finished in **236 ms** end-to-end with no
client round-trip (the 5 MB express.json ceiling no longer applies to URL/PDF imports);
initial reader render 1.0 s eager → **0.69 s** with 1 span injected up front (spans appear
per-block near the viewport; programmatic seeks force-inject). Page markers + 400-entry
Contents panel verified visually in Chrome.

Lessons:
- Digit-normalized repetition detection will eat body prose differing only by a number —
  the ≤70-char furniture guard is what makes it safe. Caught by tests before shipping.
- A hash-routed SPA keeps running old JS after a deploy; hard-reload before browser-verifying.
- The claude-in-chrome tab reports visibilityState 'hidden': rAF and IntersectionObserver
  never fire there, and HTMLMediaElement won't start — UI structure is verifiable via
  screenshots/JS, but anything rendering-loop-driven needs `npm run e2e` (headless Chrome).

Plan: ~/.claude/plans/nested-chasing-whistle.md

- [x] Scaffold: package.json, deps installed, .env.example, .gitignore, vitest.config.js
- [x] Verify edge-tts-universal API surface against installed .d.ts (Communicate/stream/TTSChunk/listVoices — matches plan)
- [x] server/lib/segment.js (sentences via Intl.Segmenter + chunk packing) + unit tests
- [x] server/lib/cache.js + server/lib/semaphore.js + unit tests
- [x] server/lib/words.js (Edge boundary matcher + ElevenLabs alignment aggregation) + unit tests
- [x] server/providers/edge.js + mocked unit tests
- [x] Edge LIVE integration test passes (real mp3 + word boundaries verified)
- [x] server/providers/elevenlabs.js + providers/index.js + unit tests (live test auto-skips without key)
- [x] Extraction: lib/extract/blocks.js, url.js, pdf.js + fixtures + unit tests
- [x] Live URL extraction integration test passes (Wikipedia)
- [x] lib/store.js + routes (extract/tts/voices/docs) + app.js/index.js + supertest suite (56 unit tests green)
- [x] Frontend: index.html, style.css, js/(api, main, reader, queue, player, highlight) — wired as each lands
- [x] Full test suite green (59 passed, 1 skipped = ElevenLabs live awaiting key)
- [x] End-to-end pass via headless-Chrome e2e (`npm run e2e`, 8/8): paste → save → real playback →
      karaoke word sweep → gapless chunk handoff → click-to-jump → rate stepper → reload-resume.
      URL flow + library list + reader UI verified in live browser; PDF + error paths covered by
      unit/route tests against real fixtures.
- [x] README + final sweep (removed unwired exports: packChunks, queue.retry, reader.clearHighlights/deactivateChunk)

## Round 6 — Supertonic provider (on-device ONNX TTS, proportional word timing)

Goal: add Supertone's `supertonic-3` as a third TTS provider — fully on-device (no network,
no key), behind the same `{audio, format:'mp3', words}` interface. Supertonic only emits a
single total clip duration (flow-matching arch, no token→frame alignment), so word timings are
**approximated proportionally** (linear char→time map over the original chunk text). User chose
this pragmatic path over a heavy forced-aligner. Output WAV→mp3 in-provider to honor the
existing contract (both clients hardcode `audio/mpeg`; cache file is `.mp3`).

- [x] Vendor upstream `helper.js` (MIT) → `server/providers/supertonic/helper.js` (verbatim + attribution)
- [x] `server/lib/words.js`: add `durationToWords(text, totalSeconds)` (Intl.Segmenter, linear char→time map)
- [x] `server/lib/mp3.js`: `pcmFloatToMp3(floats, sampleRate)` via `@breezystack/lamejs` (pure JS)
- [x] `server/providers/supertonic.js`: available()/synthesize()/voices(); lazy-load sessions+styles; SUPERTONIC_DIR
- [x] Wire `server/providers/index.js` + `server/routes/voices.js` + `public/js/main.js` voice picker
- [x] `scripts/fetch-supertonic.mjs` + npm `fetch:supertonic` (downloads ~398MB from HF → data/supertonic)
- [x] package.json deps: `onnxruntime-node@^1.26`, `@breezystack/lamejs@^1.2.7`
- [x] Unit tests: words map, mp3 encode, provider wiring (mock vendored helper) — 7 new, all green
- [x] Live integration test `supertonic.live.test.js` (self-skips until assets downloaded); real synth passes

**Round 6 review**: Supertonic wired as a 3rd provider behind the same `{audio, format:'mp3', words}`
contract. Corrected a mid-task error — earlier I claimed per-character durations were recoverable;
reading the real `helper.js` showed the duration_predictor emits only one **total clip duration**
(flow-matching, no token alignment), so word timing is proportional (linear char→time, exact char
offsets so highlight + click-to-jump still anchor). WAV→mp3 in-provider so clients/cache/contract
are untouched (both clients hardcode `audio/mpeg`). Gated on on-disk assets like ElevenLabs gates on
a key. **Verified**: 92 unit+integration pass (1 skip = ElevenLabs no-key); live ONNX synth (~398MB
load + inference) = 1.76s producing valid mp3 + 6 proportional words; HTTP path confirmed end-to-end
(voices lists 10 styles, POST /api/tts synth + cache-hit). **Lessons**: (1) don't trust WebFetch
auto-summaries for code semantics — `durOnnx[i]/=speed` looped over batch size, not tokens; read the
source. (2) Adding a provider touches the voices route mock in routes.test.js — registry shape is
asserted there too. **Follow-ups (not done)**: packaged desktop needs `SUPERTONIC_DIR` set to its
userData path (provider self-disables otherwise); multilingual (`lang` is hardcoded 'en').

## Review

**Built**: "Lectern" — personal Speechify clone. Express 5 + vanilla-JS frontend (no build step).
Inputs: URL (Readability), PDF (unpdf, scanned → friendly 422), paste. TTS providers behind a
uniform interface: Edge TTS (default, free, keyless) + ElevenLabs (auto-enabled by .env key);
both return word timestamps, so karaoke word highlighting works on either. Sentences via
Intl.Segmenter (no regex parsing), packed into ≤300-char chunks that never cross paragraphs;
audio disk-cached by sha256(provider|voice|text); dual-audio gapless playback with prefetch
window; position autosave + resume; speed 0.5–3× pitch-preserving; keyboard shortcuts.

**Verification**: 56 unit tests; live integration tests hit the real Edge service (mp3 magic
bytes + monotonic word timings) and real Wikipedia extraction — keyless, so they always run;
ElevenLabs live test self-skips loudly until a key lands in .env. Headless-Chrome e2e drives
the real UI with real audio (muted sink): 8/8.

**Notes / lessons**:
- The claude-in-chrome automation tab cannot start HTMLMediaElement playback (no user-activation
  through CDP input; one tab even wedged its media pipeline at readyState 0). Verifying audio
  requires `npm run e2e` (Chrome with --autoplay-policy=no-user-gesture-required). The app
  correctly degrades when play() is blocked: reverts to paused + toast.
- Intl.Segmenter only splits sentences when the next starts uppercase — a unit-test fixture
  initially relied on lowercase continuation and "failed" against correct behavior.
- Edge TTS boundary offsets are 100-ns ticks (÷10,000 → ms); output format is fixed mp3 24kHz.

## Round 10 — pre-publication security review (4 adversarial reviewers, 5 fix agents)

Goal: the repo goes public, so strangers install the extension and run the engine. Four
read-only reviewers attacked one surface each (extension trust boundary, HTTP surface,
desktop + supply chain, web client + stored content); fixes were implemented across disjoint
file sets and verified.

### Fixed
- [x] **SSRF guard bypass (HIGH)** — `ipBlocked` matched the *text* of an IPv6 host, but URL
      parsing rewrites `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, so loopback/IMDS/RFC1918 were
      reachable through `/api/docs/import/url` and read back in the 201 body. Now expands the
      literal to eight numeric groups and decodes every embedded-IPv4 form (mapped,
      compatible, translated, NAT64 well-known + local-use, 6to4); multicast and 240/4 added.
- [x] **Redirect bodies were buffered uncapped** — 302 with a 400 MB body drove RSS to 1.4 GB;
      now `body.cancel()` (RSS delta 10 MB).
- [x] **Session hijack across a navigation (HIGH)** — the SW keyed a session on `tabId`, so a
      later document in that tab could `seek` and replay the previous page's text back to
      itself through the bridge. Sessions now pin to `sender.documentId`, pushes address that
      document, and `tabs.onUpdated` tears down on a document load.
- [x] **Arm replay (HIGH)** — an unspent 10 s arm survived a navigation. Arms now carry a
      nonce handed only to the document that received the gesture.
- [x] **Write amplification** — one save per session; provider:voice checked against
      `/api/voices` with a 1 s cooldown (a voice rotation misses the audio cache, which is
      never pruned); bounds on blocks mirror `lib/limits.js`.
- [x] **Provenance spoofing** — title/URL now come from the browser (`sender.url`,
      `tabs.get`), never from the page's message.
- [x] **PDF/OCR resource bombs** — 433-byte PDF rendered 14400×14400 (2.8 GB RSS): render
      scale clamped to a 40 MP budget + whole-import OCR deadline. `saveExtracted` now applies
      `blocksOverLimit`, so `/import/url` and `/import/pdf` are capped like the other routes.
- [x] **SSML injection via `voice`** — the id is interpolated into SSML unescaped upstream;
      every provider now validates the id it publishes before synthesis.
- [x] **Engine impersonation (HIGH)** — the desktop app trusted `res.ok` from whatever held
      :3000. Now `GET /api/health` with a per-user 0600 token (401 anonymously *first*, so a
      squatter never receives the token) plus a version gate, so a stale engine cannot silently
      keep serving old code.
- [x] Front gate: CSP on everything served, `Sec-Fetch-Site` for Origin-less cross-site GETs,
      and **one** allowlisted extension id (frozen by `manifest.key`) instead of every
      `chrome-extension://` origin.
- [x] Electron navigation policy (window-open, will-navigate, webview), symlink refusal and
      id validation on PDF drag-to-dock.
- [x] Client: `Object.hasOwn` map lookups, route race guard, malformed-hash guard, last
      unescaped `innerHTML` interpolation removed, bidi/zero-width strip in normalization.
- [x] Supply chain: Supertonic weights pinned to a commit sha with a sha256 map and
      verify-before-rename; `contents: write` scoped to the release job; release action pinned
      to a sha; `ONNXRUNTIME_NODE_INSTALL=skip` on Linux CI; LICENSE, SECURITY.md, launchd
      template, `.gitignore` for `.entire/`.
- [x] Privacy: Google Fonts self-hosted (15 woff2, 776 KB) so the CSP stays `'self'`-only.
- [x] Dependencies: `npm update` → axios 1.20.0, electron 42.11.2; `npm audit` 0 vulnerabilities.

**Verification**: 223 unit + live integration (229 passed, 1 skipped = ElevenLabs, no key);
web e2e 13/13; desktop e2e 7/7 against a fresh `dist:mac`; extension e2e 27/28. Live probes
against the running engine: rebound Host 403, cross-origin 403, cross-site GET 403, another
extension's origin 403, `[::ffff:127.0.0.1]` and `[::ffff:169.254.169.254]` blocked, SSML
payload rejected.

**Known failing check (pre-existing, NOT from this round)**: `floating player drags to a new
position` in `e2e:extension` — the first drag is a no-op and the bar stays at its centered
mount point (111, 514); the later viewport-clamp drag passes. Reproduced identically with the
extension logic reverted to `HEAD`, so it predates the security work. Suspect pointer capture
inside the shadow root under the current headless Chrome.

**Follow-ups not done**: regenerate `package-lock.json` for linux+darwin
(`npm install --os=linux --cpu=x64 --os=darwin --cpu=arm64`) so CI can return to `npm ci`;
replace the stale `/Applications/Lectern.app` (June build, no front gate) with the new
`dist/mac-arm64/Lectern.app`; drop the always-on MAIN-world content script in favor of
on-demand injection before any Web Store submission (it fingerprints Lectern users via
`window.__lecternCore`); strip the `__lectern*` e2e hooks from a published extension zip.
