// Extension end-to-end: loads the unpacked MV3 extension into Chrome
// (puppeteer `enableExtensions` — branded Chrome ≥137 removed --load-extension),
// reads a fixture article page, and asserts in-place karaoke highlighting,
// pause/resume (incl. offscreen rehydration), and save-to-library.
//
// Requires the Lectern server on http://localhost:3000:  npm run e2e:extension
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const API = 'http://127.0.0.1:3000';
const LONG_PAUSE_MS = Number(process.env.LECTERN_E2E_PAUSE_MS ?? 35_000);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`Timed out: ${label}`);
}

// fixture page on its own port (content scripts don't run on data: URLs);
// /tt serves the same article under Trusted Types enforcement, mirroring
// gemini.google.com & other Google properties where innerHTML throws
const article = readFileSync(path.join(root, 'test', 'fixtures', 'article.html'), 'utf8');
const fixtureServer = createServer((req, res) => {
  const headers = { 'Content-Type': 'text/html' };
  if (req.url.startsWith('/tt')) headers['Content-Security-Policy'] = "require-trusted-types-for 'script'";
  res.writeHead(200, headers);
  res.end(article);
});
await new Promise((r) => fixtureServer.listen(0, '127.0.0.1', r));
const fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}/article`;
const ttUrl = `http://127.0.0.1:${fixtureServer.address().port}/tt`;

const health = await fetch(`${API}/api/docs`).catch(() => null);
if (!health?.ok) {
  console.error('Lectern server is not running on :3000 — start it first (npm start)');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  pipe: true,
  enableExtensions: [path.join(root, 'extension')],
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1300,900'],
});

try {
  // the extension must finish loading BEFORE the fixture page navigates:
  // a page loaded earlier has no manifest content scripts, and the SW can't
  // dynamically inject into it (no activeTab from a hook call, no host
  // permission for the fixture port) — seen as a mount timeout on slow CI
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().endsWith('sw.js'),
    { timeout: 10_000 },
  );
  const sw = await swTarget.worker();
  check('extension service worker is up', Boolean(sw));

  // — ADVERSARIAL: a page the user never activated must not be able to forge
  //   SW control messages through the MAIN-world↔bridge channel. This tab is
  //   never armed via a trusted gesture, so the SW must drop session-start
  //   (no session, no player, no audio) and save-library (no library write).
  {
    const evilPage = await browser.newPage();
    await evilPage.goto(fixtureUrl, { waitUntil: 'networkidle0' });
    const docsBeforeEvil = await fetch(`${API}/api/docs`).then((r) => r.json());
    await evilPage.evaluate(() => {
      const post = (msg) => window.postMessage({ __lectern: 'up', msg }, '*');
      post({ type: 'session-start', blocks: [{ type: 'p', text: 'Injected by a hostile page.' }], title: 'EVIL', url: 'http://evil.test/' });
      post({ type: 'save-library' });
      post({ type: 'voice', provider: 'edge', voice: '../../../package' });
    });
    await sleep(1500);
    const clean = await sw.evaluate(() => globalThis.__lecternState().then((s) => s.session === null && s.offscreen === false));
    check('forged page messages cannot start a session (gesture gate)', clean);
    const noMount = await evilPage.evaluate(() => !document.querySelector('[data-lectern]'));
    check('forged session-start does not mount the player', noMount);
    const docsAfterEvil = await fetch(`${API}/api/docs`).then((r) => r.json());
    check('forged save-library writes nothing to the library', docsAfterEvil.length === docsBeforeEvil.length, `${docsBeforeEvil.length}→${docsAfterEvil.length}`);
    await evilPage.close();
  }

  const page = await browser.newPage();
  await page.goto(fixtureUrl, { waitUntil: 'networkidle0' });

  // — start a page read via the SW hook (same code path as a toolbar click)
  const startedTab = await sw.evaluate(() => globalThis.__lecternStart('page'));

  const playerMounted = await poll(
    () => page.evaluate(() => Boolean(document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.bar'))),
    15_000,
    'floating player',
  );
  check('floating player mounts in the page', playerMounted, `tab ${startedTab}`);

  // — the bar is movable: drag by the status area moves the host exactly with
  //   the pointer; mouse-down on a control never drags; clamping keeps the bar
  //   on-screen however far the pointer goes (it ends parked top-right, away
  //   from the text the later click-to-jump step clicks)
  {
    const grabPoint = () =>
      page.evaluate(() => {
        const host = document.querySelector('[data-lectern]');
        const s = host.shadowRoot.querySelector('.status').getBoundingClientRect();
        const h = host.getBoundingClientRect();
        return { x: s.x + s.width / 2, y: s.y + s.height / 2, left: h.left, top: h.top };
      });
    const hostRect = () =>
      page.evaluate(() => {
        const r = document.querySelector('[data-lectern]').getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, vw: window.innerWidth, vh: window.innerHeight };
      });

    // deltas small enough to stay clear of the viewport clamp (default 800×600)
    const before = await grabPoint();
    await page.mouse.move(before.x, before.y);
    await page.mouse.down();
    await page.mouse.move(before.x - 80, before.y - 200, { steps: 10 });
    await page.mouse.up();
    const dragged = await hostRect();
    const exact =
      Math.abs(dragged.left - (before.left - 80)) < 2 && Math.abs(dragged.top - (before.top - 200)) < 2;
    check('floating player drags to a new position', exact, `(${Math.round(dragged.left)}, ${Math.round(dragged.top)})`);

    const play = await page.evaluate(() => {
      const b = document.querySelector('[data-lectern]').shadowRoot.querySelector('.play').getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    });
    await page.mouse.move(play.x, play.y);
    await page.mouse.down();
    await page.mouse.move(play.x + 30, play.y, { steps: 5 }); // stays inside the bar → no page click
    await page.mouse.up();
    const afterButton = await hostRect();
    check(
      'dragging from a control does not move the bar',
      afterButton.left === dragged.left && afterButton.top === dragged.top,
    );

    const grab2 = await grabPoint();
    await page.mouse.move(grab2.x, grab2.y);
    await page.mouse.down();
    await page.mouse.move(2000, 10, { steps: 10 });
    await page.mouse.up();
    const clamped = await hostRect();
    const onScreen =
      clamped.left >= 0 && clamped.top >= 0 && clamped.right <= clamped.vw && clamped.bottom <= clamped.vh;
    check('drag clamps the player inside the viewport', onScreen, `(${Math.round(clamped.left)}, ${Math.round(clamped.top)})–(${Math.round(clamped.right)}, ${Math.round(clamped.bottom)}) in ${clamped.vw}×${clamped.vh}`);
  }

  const firstWord = await poll(
    () =>
      page.evaluate(() => {
        const h = CSS.highlights.get('lectern-word');
        if (!h || h.size === 0) return null;
        return [...h.values()][0].toString() || null;
      }),
    20_000,
    'first word highlight',
  );
  check('karaoke word highlight paints via CSS.highlights', Boolean(firstWord), `first word "${firstWord}"`);

  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    const w = await page.evaluate(() => {
      const h = CSS.highlights.get('lectern-word');
      return h && h.size ? [...h.values()][0].toString() : null;
    });
    if (w) seen.add(w);
    await sleep(500);
  }
  check('highlight sweeps multiple words', seen.size >= 3, `${seen.size} distinct words`);

  const sentenceText = await page.evaluate(() => {
    const h = CSS.highlights.get('lectern-sentence');
    return h && h.size ? [...h.values()][0].toString() : null;
  });
  check('sentence wash highlights in place', Boolean(sentenceText), `"${(sentenceText ?? '').slice(0, 40)}…"`);

  const offscreenUp = await sw.evaluate(() => globalThis.__lecternState().then((s) => s.offscreen));
  check('offscreen audio document exists', offscreenUp);

  // — click-to-jump: real mouse click on a later paragraph seeks the audio there
  const target = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const idx = node.data.indexOf('remarkably good interface');
      if (idx !== -1) {
        const r = document.createRange();
        r.setStart(node, idx);
        r.setEnd(node, idx + 10);
        const rect = r.getBoundingClientRect();
        node.parentElement.scrollIntoView({ block: 'center' });
        const rect2 = r.getBoundingClientRect();
        return { x: rect2.x + rect2.width / 2, y: rect2.y + rect2.height / 2 };
      }
    }
    return null;
  });
  await page.mouse.click(target.x, target.y);
  const jumped = await poll(
    () =>
      page.evaluate(() => {
        const h = CSS.highlights.get('lectern-sentence');
        const text = h && h.size ? [...h.values()][0].toString() : '';
        return text.includes('remarkably good interface') ? text : null;
      }),
    10_000,
    'click-to-jump sentence',
  );
  check('clicking page text jumps audio to that sentence', Boolean(jumped), `"${jumped?.slice(0, 50)}…"`);

  // — pause, wait past the offscreen 30s shutdown, resume → rehydration
  await page.evaluate(() => document.querySelector('[data-lectern]').shadowRoot.querySelector('.play').click());
  await sleep(1000);
  const pausedState = await sw.evaluate(() => globalThis.__lecternState());
  check('pause persists session position', pausedState.session?.chunkIdx >= 0 && pausedState.session.blocks > 0);

  console.log(`   (waiting ${Math.round(LONG_PAUSE_MS / 1000)}s for Chrome to close the idle offscreen doc…)`);
  await sleep(LONG_PAUSE_MS);
  const offscreenGone = await sw.evaluate(() => globalThis.__lecternState().then((s) => s.offscreen));
  check('offscreen document closed while paused', offscreenGone === false, 'expected per AUDIO_PLAYBACK idle rule');

  const chunkBefore = pausedState.session.chunkIdx;
  await page.evaluate(() => document.querySelector('[data-lectern]').shadowRoot.querySelector('.play').click());
  const resumed = await poll(
    () =>
      sw.evaluate(() =>
        globalThis.__lecternState().then((s) => (s.offscreen ? s.session : null)),
      ),
    15_000,
    'rehydrated offscreen',
  );
  check('resume rehydrates audio at the saved position', resumed.chunkIdx >= chunkBefore, `chunk ${resumed.chunkIdx}`);

  const moving = await poll(
    () =>
      page.evaluate(() => {
        const h = CSS.highlights.get('lectern-word');
        return h && h.size ? [...h.values()][0].toString() : null;
      }),
    15_000,
    'highlight after resume',
  );
  check('highlighting continues after resume', Boolean(moving));

  // — save to library
  const docsBefore = await fetch(`${API}/api/docs`).then((r) => r.json());
  await page.evaluate(() => document.querySelector('[data-lectern]').shadowRoot.querySelector('.save').click());
  const savedDoc = await poll(async () => {
    const docs = await fetch(`${API}/api/docs`).then((r) => r.json());
    return docs.find((d) => !docsBefore.some((b) => b.id === d.id)) ?? null;
  }, 10_000, 'saved doc');
  check('save-to-library creates a Lectern doc', Boolean(savedDoc), `"${savedDoc?.title}"`);
  await fetch(`${API}/api/docs/${savedDoc.id}`, { method: 'DELETE' });

  // — SPA re-read: the toolbar icon is a "read this" gesture, not a transport
  //   control. Unchanged page → it toggles; content that arrived since the
  //   last read → it reads only that (no page reload); a selection → it reads
  //   the selection. __lecternStart drives the same path as action.onClicked.
  const shadowStatus = () =>
    page.evaluate(() => document.querySelector('[data-lectern]').shadowRoot.querySelector('.status').textContent);
  const blockCount = () => sw.evaluate(() => globalThis.__lecternState().then((s) => s.session?.blocks ?? -1));
  const highlightIn = (selector) =>
    page.evaluate((sel) => {
      const h = CSS.highlights.get('lectern-word');
      if (!h || h.size === 0) return null;
      const range = [...h.values()][0];
      const host = document.querySelector(sel);
      return host && host.contains(range.startContainer) ? range.toString() : null;
    }, selector);

  {
    const before = await blockCount();
    await sw.evaluate((id) => globalThis.__lecternStart('auto', id), startedTab);
    const paused = await poll(async () => ((await shadowStatus()) === 'Paused' ? true : null), 10_000, 'toggle to paused')
      .catch(() => false);
    check('re-click on an unchanged page toggles playback', paused, `status "${await shadowStatus()}"`);
    check('unchanged page is not re-extracted', (await blockCount()) === before, `${before} blocks`);
  }

  {
    await page.evaluate(() => {
      const p = document.createElement('p');
      p.id = 'spa-answer';
      p.textContent =
        'This answer arrived long after the reader had already started. Lectern should notice it without a page reload. Reading it aloud proves the re-click path really works.';
      document.querySelector('article').appendChild(p);
    });
    await sw.evaluate((id) => globalThis.__lecternStart('auto', id), startedTab);
    const grown = await poll(() => blockCount().then((n) => (n === 1 ? n : null)), 15_000, 'session rebuilt from new content')
      .catch(() => null);
    check('re-click after new content reads only what arrived', grown === 1, `${grown} block(s)`);
    const inNew = await poll(() => highlightIn('#spa-answer'), 25_000, 'highlight inside the new content').catch(
      () => null,
    );
    check('karaoke follows into the newly arrived text', Boolean(inNew), `word "${inNew}"`);
  }

  {
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.querySelector('blockquote p'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await sw.evaluate((id) => globalThis.__lecternStart('auto', id), startedTab);
    const inQuote = await poll(() => highlightIn('blockquote'), 25_000, 'highlight inside the selection').catch(
      () => null,
    );
    check('a selection wins the toolbar click', Boolean(inQuote), `word "${inQuote}"`);
    await page.evaluate(() => window.getSelection().removeAllRanges());
  }

  // — teardown via close button
  await page.evaluate(() => document.querySelector('[data-lectern]').shadowRoot.querySelector('.close').click());
  await sleep(800);
  const cleared = await page.evaluate(
    () => !CSS.highlights.has('lectern-word') && !document.querySelector('[data-lectern]'),
  );
  check('close clears highlights and UI', cleared);

  // — Trusted Types page (gemini.google.com regression): the MAIN-world engine
  // must mount and highlight without touching an HTML-string sink
  const ttPage = await browser.newPage();
  await ttPage.goto(ttUrl, { waitUntil: 'networkidle0' });
  const ttEnforced = await ttPage.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<b>x</b>';
      return false;
    } catch {
      return true;
    }
  });
  check('fixture page enforces Trusted Types', ttEnforced, 'innerHTML assignment throws');

  // no "tabs" permission → tab.url is invisible to the SW; bringToFront makes
  // this tab the active one so the hook resolves it like a real toolbar click
  await ttPage.bringToFront();
  await sw.evaluate(() => globalThis.__lecternStart('page'));
  const ttMounted = await poll(
    () =>
      ttPage.evaluate(() => Boolean(document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.bar'))),
    15_000,
    'floating player on Trusted Types page',
  );
  check('player mounts under require-trusted-types-for', ttMounted);

  const ttWord = await poll(
    () =>
      ttPage.evaluate(() => {
        const h = CSS.highlights.get('lectern-word');
        return h && h.size ? [...h.values()][0].toString() : null;
      }),
    20_000,
    'word highlight on Trusted Types page',
  );
  check('karaoke highlight works under Trusted Types', Boolean(ttWord), `first word "${ttWord}"`);
  await ttPage.evaluate(() => document.querySelector('[data-lectern]').shadowRoot.querySelector('.close').click());

  // — On-device voices end-to-end: a read in a known voice, then a switch
  //   through the shadow-DOM picker 1.5 s into the article's first paragraph.
  //   The offscreen 'voice' handler restarts that chunk with the new provider,
  //   which exercises the on-device synth path that used to hang on
  //   "synthesizing". Three things must hold:
  //   - The switch aborts the previous voice's requests still in flight;
  //     otherwise they keep the engine's on-device queue busy and the new
  //     voice waits behind them. Before the switch, every request except the
  //     three chunks playback needs first is held, so the prefetched ones are
  //     always in flight when it happens; they are let go once the new voice
  //     asks for audio, and one that then completes was never aborted.
  //   - Nothing plays while the new voice synthesizes, so the karaoke highlight
  //     holds still until the bar leaves its loading state. A clock that runs
  //     on past its last time update sweeps through words nobody hears, and
  //     that phantom motion once passed this check. The new voice's requests
  //     are held for HOLD_AFTER_MS, so the loading phase is long enough to
  //     judge even when the audio cache is warm.
  //   - The new voice restarts the chunk, so its first highlighted word comes
  //     before the held one.
  //   Chrome closes an AUDIO_PLAYBACK offscreen document it hears nothing from
  //   for 30 s, and under --mute-audio it hears nothing at all, so each check
  //   starts on a fresh document and must finish within its 30 s. An in-page
  //   probe samples the highlight every 50 ms and on each loading toggle.
  //   Skips a voice whose on-device assets the engine lacks.
  const HOLD_AFTER_MS = 1500;
  // The fixture's first three chunks: its title, byline and first paragraph.
  const PLAYS_BEFORE_SWITCH = ['The Quiet Rise', 'By Jane Doe', 'Audiobooks were once'];
  const ttsBody = (request) => {
    const body = request.postData ?? (request.postDataEntries ?? []).map((e) => atob(e.bytes ?? '')).join('');
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  };

  async function checkVoiceSwitch(name, prefix, from) {
    const page = await browser.newPage();
    let cdp = null;
    try {
      // A read starts in the saved default voice.
      const startVoice = await sw.evaluate(async (candidates) => {
        const voices = await (await fetch('http://127.0.0.1:3000/api/voices')).json();
        for (const provider of candidates) {
          const voice = voices[provider]?.available === false ? null : voices[provider]?.voices?.[0]?.id;
          if (!voice) continue;
          const saved = (await chrome.storage.local.get('lectern.defaults'))['lectern.defaults'];
          await chrome.storage.local.set({ 'lectern.defaults': { ...saved, provider, voice } });
          return `${provider}:${voice}`;
        }
        return null;
      }, [from, 'edge']);
      const isOffscreen = (t) => t.url().endsWith('/offscreen.html');
      const staleDocs = new Set(browser.targets().filter(isOffscreen));
      await sw.evaluate(() => chrome.offscreen.closeDocument().catch(() => {}));
      await poll(
        async () => (await sw.evaluate(() => globalThis.__lecternState())).offscreen === false,
        5_000,
        'previous offscreen document closed',
      );
      await page.goto(fixtureUrl, { waitUntil: 'networkidle0' });
      await page.bringToFront();
      await sw.evaluate(() => globalThis.__lecternStart('page'));
      await poll(
        () => page.evaluate(() => Boolean(document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.bar'))),
        15_000,
        `player for ${name} read`,
      );
      const value = await poll(
        () =>
          page.evaluate((prefix) => {
            const sel = document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.voice');
            if (!sel || sel.options.length === 0) return null;
            const opt = [...sel.options].find((o) => o.value.startsWith(`${prefix}:`));
            return opt ? opt.value : 'absent';
          }, prefix),
        15_000,
        'voice picker populated',
      ).catch(() => 'absent');
      if (value === 'absent') {
        check(`extension: ${name} voice available (SKIPPED — on-device assets absent)`, true, 'skip');
        return;
      }

      // Watch and hold the offscreen player's /api/tts traffic.
      const offscreen = await browser.waitForTarget((t) => isOffscreen(t) && !staleDocs.has(t), { timeout: 15_000 });
      const docAt = Date.now();
      cdp = await offscreen.createCDPSession();
      const traffic = { switched: false, newVoiceAsked: false, heldOld: [], aborted: 0, late: 0 };
      const providerOf = new Map(); // Network requestId → provider
      const isOld = (requestId) => providerOf.has(requestId) && providerOf.get(requestId) !== prefix;
      const release = (requestId, afterMs = 0) =>
        setTimeout(() => cdp.send('Fetch.continueRequest', { requestId }).catch(() => {}), afterMs);
      const noteNewVoice = (request) => {
        if (traffic.newVoiceAsked || !traffic.switched || ttsBody(request).provider !== prefix) return;
        traffic.newVoiceAsked = true;
        traffic.heldOld.splice(0).forEach((requestId) => release(requestId));
      };
      cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
        if (!request.url.endsWith('/api/tts')) return;
        providerOf.set(requestId, ttsBody(request).provider);
        noteNewVoice(request);
      });
      cdp.on('Network.loadingFinished', ({ requestId }) => {
        if (traffic.newVoiceAsked && isOld(requestId)) traffic.late++;
      });
      cdp.on('Network.loadingFailed', ({ requestId, canceled }) => {
        if (traffic.switched && canceled && isOld(requestId)) traffic.aborted++;
      });
      cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        noteNewVoice(request);
        const { provider, text = '' } = ttsBody(request);
        if (provider === prefix) release(requestId, HOLD_AFTER_MS);
        else if (traffic.newVoiceAsked || PLAYS_BEFORE_SWITCH.some((p) => text.startsWith(p))) release(requestId);
        else traffic.heldOld.push(requestId);
      });
      await cdp.send('Network.enable');
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/tts' }] });

      // Chunk 2 is the article's first paragraph (0 is the title, 1 the byline).
      await poll(
        async () => {
          const { session } = await sw.evaluate(() => globalThis.__lecternState());
          return session?.chunkIdx >= 2 && session.inChunkMs >= 1500;
        },
        60_000,
        `${name}: previous voice playing the first paragraph`,
      );
      traffic.switched = true;
      const switchedAt = await page.evaluate((value) => {
        const root = document.querySelector('[data-lectern]').shadowRoot;
        const bar = root.querySelector('.bar');
        const samples = [];
        const sample = () => {
          const h = CSS.highlights.get('lectern-word');
          const r = h?.size ? [...h.values()][0] : null;
          let pos = -1;
          if (r) {
            const before = document.createRange();
            before.setStart(document.body, 0);
            before.setEnd(r.startContainer, r.startOffset);
            pos = before.toString().length;
          }
          samples.push({
            t: performance.now(),
            loading: bar.classList.contains('loading'),
            pos,
            status: root.querySelector('.status').textContent,
          });
        };
        new MutationObserver(sample).observe(bar, { attributes: true, attributeFilter: ['class'] });
        setInterval(sample, 50);
        window.__lecternProbe = samples;
        const sel = root.querySelector('.voice');
        sel.value = value;
        sel.dispatchEvent(new Event('change'));
        return performance.now();
      }, value);

      // held: distinct highlight positions while loading (1 = it stood still);
      // heard: new positions once the new voice plays.
      let outcome = { held: 0, samples: 0, heard: 0, restarted: false, loadingMs: null, status: '' };
      await poll(
        async () => {
          const after = (await page.evaluate(() => window.__lecternProbe)).filter((x) => x.t >= switchedAt);
          const start = after.findIndex((x) => x.loading);
          const end = start < 0 ? -1 : after.findIndex((x, i) => i > start && !x.loading);
          const loading = start < 0 ? [] : after.slice(start, end < 0 ? undefined : end);
          const heldAt = new Set(loading.map((x) => x.pos));
          const heard = (end < 0 ? [] : after.slice(end)).map((x) => x.pos).filter((p) => p >= 0 && !heldAt.has(p));
          outcome = {
            held: heldAt.size,
            samples: loading.length,
            heard: new Set(heard).size,
            restarted: heard.length > 0 && heard[0] < Math.min(...heldAt),
            loadingMs: end < 0 ? null : Math.round(after[end].t - switchedAt),
            status: after.at(-1)?.status ?? '',
          };
          return outcome.heard >= 2;
        },
        90_000,
        `${name} audio after the switch`,
      ).catch(() => {});
      const { session, offscreen: playerOpen } = await sw.evaluate(() => globalThis.__lecternState());
      check(
        `extension: ${name} switch aborts the previous voice's requests`,
        traffic.aborted >= 1 && traffic.late === 0,
        `from ${startVoice}: ${traffic.aborted} aborted, ${traffic.late} completed after the switch`,
      );
      const firstAudio = outcome.loadingMs === null ? 'no audio within 90 s' : `first audio after ${outcome.loadingMs} ms`;
      check(
        `extension: ${name} switch holds the highlight while synthesizing`,
        outcome.samples >= 10 && outcome.held === 1,
        `${outcome.held} positions over ${outcome.samples} samples, ${firstAudio} (${HOLD_AFTER_MS} ms held)`,
      );
      check(
        `extension: ${name} synthesizes + karaoke advances from the chunk start`,
        session?.provider === prefix && outcome.heard >= 2 && outcome.restarted,
        `${value}, ${outcome.heard} words, first before the held word: ${outcome.restarted}, status "${outcome.status}", offscreen player ${playerOpen ? 'open' : 'closed'} at ${Math.round((Date.now() - docAt) / 1000)} s`,
      );
    } finally {
      await cdp?.detach().catch(() => {});
      await page
        .evaluate(() => document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.close')?.click())
        .catch(() => {});
      await page.close().catch(() => {});
    }
  }

  // The Kokoro read starts in Supertonic, so its switch also leaves on-device
  // synthesis in flight.
  await checkVoiceSwitch('Supertonic', 'supertonic', 'edge');
  await checkVoiceSwitch('Kokoro', 'kokoro', 'supertonic');
} catch (err) {
  check('extension e2e completed', false, err.message);
} finally {
  await browser.close();
  fixtureServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} extension e2e checks passed`);
process.exit(failed.length ? 1 : 0);
