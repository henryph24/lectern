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

  // — Supertonic on-device voice end-to-end: fresh read, switch the shadow-DOM
  //   voice picker to a Supertonic voice, and confirm the karaoke highlight keeps
  //   advancing. The offscreen 'voice' handler restarts the current chunk with the
  //   new provider, so this exercises the on-device synth path that used to hang on
  //   "synthesizing". Skips if the engine has no on-device assets.
  const stPage = await browser.newPage();
  await stPage.goto(fixtureUrl, { waitUntil: 'networkidle0' });
  await stPage.bringToFront();
  await sw.evaluate(() => globalThis.__lecternStart('page'));
  await poll(
    () => stPage.evaluate(() => Boolean(document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.bar'))),
    15_000,
    'player for supertonic read',
  );
  const stOpt = await poll(
    () =>
      stPage.evaluate(() => {
        const sel = document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.voice');
        if (!sel || sel.options.length === 0) return null;
        const opt = [...sel.options].find((o) => o.value.startsWith('supertonic:'));
        return opt ? opt.value : 'absent';
      }),
    15_000,
    'voice picker populated',
  ).catch(() => 'absent');
  if (stOpt === 'absent') {
    check('extension: Supertonic voice available (SKIPPED — on-device assets absent)', true, 'skip');
  } else {
    await stPage.evaluate((value) => {
      const sel = document.querySelector('[data-lectern]').shadowRoot.querySelector('.voice');
      sel.value = value;
      sel.dispatchEvent(new Event('change'));
    }, stOpt);
    const stSeen = new Set();
    for (let i = 0; i < 60 && stSeen.size < 2; i++) {
      const w = await stPage.evaluate(() => {
        const h = CSS.highlights.get('lectern-word');
        return h && h.size ? [...h.values()][0].toString() : '';
      });
      if (w) stSeen.add(w);
      await sleep(500);
    }
    check('extension: Supertonic synthesizes + karaoke advances', stSeen.size >= 2, `${stOpt}, ${stSeen.size} words`);
  }
  await stPage
    .evaluate(() => document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.close')?.click())
    .catch(() => {});
  await stPage.close().catch(() => {});

  // Kokoro on-device voice end-to-end: the same fresh read and shadow-DOM
  //   voice switch as Supertonic above. Skips if the engine has no Kokoro assets.
  const kkPage = await browser.newPage();
  await kkPage.goto(fixtureUrl, { waitUntil: 'networkidle0' });
  await kkPage.bringToFront();
  await sw.evaluate(() => globalThis.__lecternStart('page'));
  await poll(
    () => kkPage.evaluate(() => Boolean(document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.bar'))),
    15_000,
    'player for kokoro read',
  );
  const kkOpt = await poll(
    () =>
      kkPage.evaluate(() => {
        const sel = document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.voice');
        if (!sel || sel.options.length === 0) return null;
        const opt = [...sel.options].find((o) => o.value.startsWith('kokoro:'));
        return opt ? opt.value : 'absent';
      }),
    15_000,
    'voice picker populated',
  ).catch(() => 'absent');
  if (kkOpt === 'absent') {
    check('extension: Kokoro voice available (SKIPPED — on-device assets absent)', true, 'skip');
  } else {
    await kkPage.evaluate((value) => {
      const sel = document.querySelector('[data-lectern]').shadowRoot.querySelector('.voice');
      sel.value = value;
      sel.dispatchEvent(new Event('change'));
    }, kkOpt);
    const kkSeen = new Set();
    for (let i = 0; i < 60 && kkSeen.size < 2; i++) {
      const w = await kkPage.evaluate(() => {
        const h = CSS.highlights.get('lectern-word');
        return h && h.size ? [...h.values()][0].toString() : '';
      });
      if (w) kkSeen.add(w);
      await sleep(500);
    }
    check('extension: Kokoro synthesizes + karaoke advances', kkSeen.size >= 2, `${kkOpt}, ${kkSeen.size} words`);
  }
  await kkPage
    .evaluate(() => document.querySelector('[data-lectern]')?.shadowRoot?.querySelector('.close')?.click())
    .catch(() => {});
  await kkPage.close().catch(() => {});
} catch (err) {
  check('extension e2e completed', false, err.message);
} finally {
  await browser.close();
  fixtureServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} extension e2e checks passed`);
process.exit(failed.length ? 1 : 0);
