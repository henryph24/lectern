# Lectern

[![CI](https://github.com/henryph24/lectern/actions/workflows/ci.yml/badge.svg)](https://github.com/henryph24/lectern/actions/workflows/ci.yml)

**A Speechify-style read-aloud app that runs entirely on your own machine.**

Point it at a webpage, a PDF, or some text, and it reads them out loud in a natural neural
voice with word-by-word karaoke highlighting, click-any-sentence-to-jump, 0.5–3× speed, and a
library that remembers where you stopped.

No account. No sign-up. No subscription. No cloud service holding your documents.

---

## What people actually use it for

- **Listening to ChatGPT, Claude, or Gemini answers.** The Chrome extension reads the live
  page, so it hears what a chat UI just rendered. Long answer? Press the toolbar button and
  listen while you do something else. When the assistant replies again, press the button once
  more: Lectern reads only the new answer.
- **Listening to code and technical docs.** Code blocks, API references, RFCs, and changelogs
  are read as normal blocks, with the current sentence highlighted in the page while it plays.
- **Reading PDFs aloud.** Drop a PDF in and press play: papers, contracts, manuals, books.
  Scanned PDFs with no text layer go through built-in OCR automatically.
- **Long articles and newsletters.** Paste a URL and Lectern extracts the article body, drops
  the navigation and ads, and reads the rest.
- **Anything else.** Paste raw text into the Paste tab.
- **Proofreading your own writing.** Hearing a draft read back catches the sentences that look
  fine and sound wrong.

---

## Everything stays on your machine

Lectern is a local Express server on `127.0.0.1:3000` plus three frontends that talk to it.
There is no Lectern backend anywhere on the internet.

| Thing | Where it lives |
| --- | --- |
| Your documents, PDFs, and pasted text | On your disk, under `data/` |
| Your library and reading positions | On your disk, under `data/` |
| Synthesized audio | Cached on your disk, under `data/cache/` |
| Analytics, telemetry, crash reports | None exist |
| Accounts, logins, sync | None exist |

The server binds to loopback (`127.0.0.1`), so nothing on your network can reach it.

**What does leave your machine, and when.** Four things, all of them either the point of the
feature or a one-time download:

| Traffic | When | How to avoid it |
| --- | --- | --- |
| The text being spoken goes to Microsoft Edge TTS | Every read with the default voice | Install the Supertonic voices: synthesis then runs on-device |
| The page you import is fetched | Only when you paste a URL | Use the Paste tab |
| An OCR language file (~15 MB) from a public CDN | Once, on your first scanned PDF | `OCR_ENABLED=0` |
| Supertonic model weights from Hugging Face | Only when you run `npm run fetch:supertonic` | Do not run it |

Nothing else is sent anywhere: no analytics, no crash reports, no fonts or scripts from a CDN,
no sync.

---

## Quick start

Requires **Node ≥ 22**.

```bash
git clone https://github.com/henryph24/speechify-clone.git
cd speechify-clone
npm install
npm start            # → http://localhost:3000
```

Open http://localhost:3000, paste a URL or drop a PDF, press play. That is the whole setup.

Keep the engine running in the background and the Chrome extension and the desktop app both
use it.

---

## Read the page you are on (Chrome extension)

This is the feature most people keep. It reads the page you are looking at, in place, with the
words highlighted as they are spoken. It works on pages a URL fetcher can never see: chat
answers, dashboards, anything behind a login, anything a JavaScript app rendered a second ago.

**Setup** (Chrome 116+):

1. Start the engine (`npm start`, or open the desktop app).
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder of this repo.

**Using it:**

| Action | What happens |
| --- | --- |
| Click the toolbar icon | Reads the main content of the page |
| Click it again while reading | Reads new content that appeared since (a fresh chat answer), or pauses if there is none |
| Select text first, then click | Reads your selection |
| Click a sentence in the page while reading | Jumps the audio there |
| Right-click → *Lectern: read selection* | Reads the highlighted text |
| Right-click → *Lectern: read from here* | Starts reading at the spot you right-clicked |
| `⌘⇧1` (macOS) / `Ctrl+Shift+1` | Play / pause from anywhere in Chrome |

The floating player bar carries the voice picker, speed, sentence skip, **Save to library**,
and it can be dragged anywhere on the page.

Highlighting uses the CSS Custom Highlight API, so the page's DOM is never modified: React
apps like Gemini and Google Docs stay intact. You can pause for as long as you like. Chrome
shuts down the idle audio document after about 30 seconds, and Lectern quietly rehydrates at
your saved position when you press play again.

---

## Read PDFs, articles, and pasted text (web app)

`npm start` → http://localhost:3000.

**Add** something with one of three tabs:

- **Web page**: paste an article URL. Readability pulls out the article body. Pages that block
  fetching suggest the Paste tab.
- **PDF**: drop a file. Repeated running headers and footers and bare page numbers are stripped
  before narration; paragraphs split across a page break are stitched back together (including
  re-joining hyphenated words); every block remembers its page, shown as `p. N` markers in the
  margin. Scanned PDFs with no text layer are sent through OCR automatically.
- **Paste text**: anything else.

**While reading:**

- `space` play / pause · `←` `→` skip one sentence · `+` `−` speed (0.5× to 3×, pitch preserved)
- Click any sentence to jump to it.
- **Contents** builds a jump list from the headings of an article or the page markers of a PDF.
- Your position saves itself. Close the tab, come back next week, press play.
- Audio is cached on disk, so a re-listen is instant and costs nothing.

---

## Desktop app (macOS)

```bash
npm run desktop      # dev mode, uses ./data
npm run dist:mac     # builds dist/mac-arm64/Lectern.app
```

Double-click the built app: no terminal window, no `npm start`. Drag a PDF onto the dock icon
to import and open it. While the app is open it hosts the engine for the extension too, so one
library is shared by all three surfaces. Its data lives in
`~/Library/Application Support/Lectern/data`.

The build is unsigned and meant for the machine that built it (no notarization, no Web Store
packaging).

---

## Voices

Open the voice picker in any surface; all installed providers appear in one list.

**Microsoft Edge TTS** (default, active out of the box). Free, no API key, and it returns real
word timestamps, which is what drives the karaoke highlight. The picker shows a curated set of
ten English voices; the full Microsoft catalog is available at `/api/voices?all=1`. Text is
synthesized on Microsoft's servers.

**Supertonic** (on-device, fully offline). Ten preset voices running locally through ONNX:

```bash
npm run fetch:supertonic     # ~398 MB of model weights → data/supertonic/
```

The voices appear as soon as the download finishes. Synthesis is CPU-bound, so each chunk takes
a few seconds on a laptop. Nothing leaves your machine.

**ElevenLabs** (optional, paid, needs a key). Create `.env` from `.env.example`:

```
ELEVENLABS_API_KEY=sk_...
```

Restart the engine and the ElevenLabs voices join the picker.

---

## Where your data lives, and how to reclaim space

Everything sits under `data/` in the repo (or `~/Library/Application Support/Lectern/data` for
the packaged app):

- `data/docs/` full documents · `data/meta/` small library summaries · `data/positions/`
  resume-position sidecars
- `data/cache/` synthesized audio, keyed by voice and text
- `data/supertonic/` on-device model weights, if you fetched them
- `data/ocr-cache/` the OCR language file, downloaded on the first scanned PDF

The audio cache grows forever by design (a re-listen must be free). A full book in one voice is
a few hundred MB. Delete `data/cache/` any time to reclaim the space; the next listen simply
re-synthesizes.

To wipe everything: stop the engine and delete `data/`.

---

## Security

Lectern runs a local server, and a local server is reachable by every browser tab and every
program on your machine. The engine defends itself:

- **Loopback bind plus a Host and Origin allowlist.** A website you visit cannot read your
  library, even with a DNS-rebinding trick: a request whose `Host` is not a loopback name, or
  whose `Origin` is a site, is refused. Browsers omit `Origin` on cross-site GETs, so those are
  refused through `Sec-Fetch-Site` as well.
- **One trusted extension.** The engine accepts the Lectern extension by its exact id, so other
  extensions you install cannot reach the API.
- **A strict Content-Security-Policy** on everything the app serves. The reader renders
  imported documents as text, and the policy allows no external script, style, font, image, or
  connection.
- **An egress guard on URL import.** A pasted link (or a redirect chain from one) cannot reach
  loopback, private, link-local, or cloud-metadata addresses.
- **Bounded work.** Import size caps, an OCR page and pixel budget, two concurrent synthesis
  slots, and per-provider timeouts, so one hostile document cannot pin the CPU or fill the disk.

What Lectern deliberately does **not** do:

- **No authentication for local programs.** Any program running as you can read the library
  through the API, the same way it can read `data/` directly. Lectern is single-user by design.
- **The macOS build is unsigned.** macOS cannot tell you who built it. Building it yourself
  (`npm run dist:mac`) is the trustworthy path.
- **The extension runs on every page you visit.** That is what makes read-in-place work.
  It sends page text to your local engine only.

If you add an API key, keep it private: `chmod 600 .env`.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Troubleshooting

**The extension says the engine is not running.** Start `npm start` or open the desktop app.
The extension talks to `127.0.0.1:3000` and does nothing on its own.

**A new route or a UI change does nothing.** Restart `npm start` after server changes, and
hard-reload the browser tab after frontend changes.

**Playback stalls on a Supertonic voice.** On-device synthesis needs real CPU. If you run the
engine as a background service, make sure it is not pinned to efficiency cores (on macOS
launchd, use `ProcessType=Standard`).

**A page reads out its sidebar, or refuses with "a block exceeds 50000 characters".** Some
sites give the extractor no paragraph structure at all. Select the part you want and use
*read selection*.

---

## Architecture

```
server/            Express 5 (Node ≥22, ESM, no build step)
  providers/       edge.js (edge-tts-universal) · elevenlabs.js · supertonic.js (on-device ONNX)
                   uniform {audio, format, words[{text,startMs,endMs,charStart,charEnd}]}
  lib/segment.js   Intl.Segmenter sentences → ≤300-char chunks (never split a sentence,
                   never cross a paragraph)
  lib/words.js     Edge word-boundary → char-range matcher · ElevenLabs char alignment ·
                   proportional char→time map for Supertonic
  lib/extract/     Readability+jsdom (URL) · unpdf (PDF: furniture stripping, cross-page
                   stitching, page provenance) · ocr.js (tesseract.js fallback) · text.js
  lib/store.js     docs + meta summaries + position sidecars, legacy self-migration
  routes/          /api/docs/import/{url,pdf,text,blocks} · /api/docs CRUD ·
                   /api/tts (disk-cached, per-provider timeout) · /api/segment · /api/voices
public/            vanilla ES modules, no bundler
  js/reader.js     lazy sentence-span injection (IntersectionObserver) + caret-based click
  js/queue.js      prefetch window [cur..cur+3], ≤2 concurrent, blob-URL LRU
  js/player.js     dual <audio> A/B swap for gapless chunk handoff, position autosave
  js/highlight.js  rAF + binary search over word timings → karaoke highlight + auto-scroll
desktop/main.mjs   Electron shell: runs the engine in-process, or reuses one already on :3000;
                   PDF drag-to-dock import
extension/         MV3: sw.js owns the session (storage.session, rehydratable) ·
                   offscreen.js plays the audio · content/extract-core.js walks the live DOM
                   with a normalized-run offset index so word timings map back to Ranges ·
                   content/engine.js (MAIN world, required for CSS.highlights to paint) does
                   highlighting and the floating shadow-DOM player · bridge.js relays messaging
```

## Tests

```bash
npm run test:unit          # segmentation, word mapping, cache, extraction, routes, storage
npm run test:integration   # live Edge TTS + live URL extraction (keyless, always runs);
                           # ElevenLabs and Supertonic tests self-skip until configured
npm test                   # both
npm run e2e                # web app in headless Chrome: real playback, karaoke sweep,
                           # chunk handoff, click-to-jump, rate, reload-resume
npm run e2e:extension      # unpacked extension on a fixture page: in-place highlights,
                           # 30s-pause offscreen shutdown and rehydration, save-to-library
npm run e2e:desktop        # boots Lectern.app: window, import, playback
npm run verify:all         # everything above, in order
# the e2e suites need port 3000 free and Google Chrome installed
```

## Known limits

- Multi-column PDFs (academic papers) can come out in scrambled reading order, because the PDF
  text layer is emitted in content order. Use the Paste tab for those.
- OCR handles up to 50 scanned pages per document and reads English by default
  (`OCR_LANG=deu` to change it, `OCR_ENABLED=0` to turn it off).
- Edge TTS is an unofficial endpoint. If Microsoft changes it, switch the picker to Supertonic
  or ElevenLabs, or update `edge-tts-universal`.
- A word highlight occasionally skips when the spoken form differs from the written form (some
  numbers and abbreviations). Sentence-level highlighting stays in sync by design.
- Supertonic word timings are proportional to character position, because the model reports one
  total clip duration. Highlighting stays anchored; it drifts slightly inside a long sentence.
- The audio cache is never pruned automatically.
- The macOS app is unsigned and built for the machine that builds it. There is no auto-start at
  login (add it to System Settings → Login Items by hand).
- The extension needs the engine running; the floating player says so when it is missing.

## Running it always-on

`contrib/dev.lectern.engine.plist.example` is a launchd template that keeps the engine
running in the background. Copy it to `~/Library/LaunchAgents/`, replace the placeholder
paths, and load it with `launchctl bootstrap`. Keep `ProcessType=Standard`: `Background`
pins the process to efficiency cores, which starves on-device Supertonic synthesis.

## License

MIT: see [LICENSE](LICENSE). Supertonic model weights are OpenRAIL-M licensed and are
downloaded from Hugging Face by `npm run fetch:supertonic` (pinned to one revision and
verified by sha256); the vendored `helper.js` is MIT.
