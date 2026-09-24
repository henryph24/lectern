// True end-to-end playback test: drives the real UI in headless Chrome with
// autoplay permitted (audio is muted but the playback clock runs), exercising
// paste → save → play → word highlighting → chunk handoff → click-to-jump →
// rate change → reload-resume.
//
// Run with the server up:  npm run e2e   (or: node test/e2e/playback.e2e.mjs)
import puppeteer from 'puppeteer-core';

const BASE = process.env.APP_URL ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TEXT = [
  'The quick brown fox jumps over the lazy dog. A second sentence keeps the first one company.',
  'Paragraph two starts here with more words to read aloud. The final sentence closes the test document.',
].join('\n\n');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(page, fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await page.evaluate(fn);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1400,1000'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 20_000 });

  // — paste text → save → reader opens
  await page.click('[data-tab="text"]');
  await page.type('[data-form="text"] input[name="title"]', 'E2E Playback Doc');
  await page.type('[data-form="text"] textarea', TEXT);
  await page.click('[data-form="text"] .btn');
  await waitFor(page, () => location.hash.startsWith('#/doc/'), 10_000, 'reader route');
  await waitFor(page, () => document.querySelectorAll('.sent').length >= 4, 5_000, 'sentence spans');
  check('paste → save → reader opens', true);

  const tocHidden = await page.evaluate(
    () => document.getElementById('toc-btn')?.classList.contains('is-hidden') ?? false,
  );
  check('contents button hidden for paste docs (no headings/pages)', tocHidden);

  // — play: clock advances and karaoke highlight appears
  await page.evaluate(() => document.getElementById('btn-play').click());
  await waitFor(
    page,
    () => document.getElementById('player').classList.contains('is-playing'),
    10_000,
    'playing state',
  );
  const firstWord = await waitFor(
    page,
    () => document.querySelector('.w.is-active')?.textContent ?? null,
    10_000,
    'first highlighted word',
  );
  check('playback starts with word highlight', Boolean(firstWord), `first word "${firstWord}"`);

  const elapsedMoves = await waitFor(
    page,
    () => document.getElementById('time-elapsed').textContent !== '0:00',
    10_000,
    'elapsed time movement',
  );
  check('playback clock advances', Boolean(elapsedMoves));

  // — word highlight progresses across different words
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const w = await page.evaluate(() => document.querySelector('.w.is-active')?.textContent ?? '');
    if (w) seen.add(w);
    await new Promise((r) => setTimeout(r, 500));
  }
  check('karaoke highlight sweeps multiple words', seen.size >= 3, `${seen.size} distinct words`);

  // — chunk handoff: second paragraph's sentence eventually becomes active
  const reachedPara2 = await waitFor(
    page,
    () => document.querySelector('.sent.is-active')?.textContent?.includes('Paragraph two') ?? false,
    30_000,
    'second chunk activation',
  ).catch(() => false);
  check('gapless chunk handoff reaches paragraph two', Boolean(reachedPara2));

  // — click-to-jump on the final sentence
  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.sent')];
    spans[spans.length - 1].click();
  });
  await new Promise((r) => setTimeout(r, 1500));
  const jumped = await page.evaluate(
    () => document.querySelector('.sent.is-active')?.textContent ?? '',
  );
  check('click-a-sentence jumps playback', jumped.includes('final sentence'), `active: "${jumped.slice(0, 50)}"`);

  // — rate stepper
  await page.evaluate(() => document.getElementById('rate-up').click());
  const rateText = await page.evaluate(() => document.getElementById('rate-value').textContent);
  check('rate stepper works', rateText.includes('1.25'), rateText);

  // — position autosave + resume on reload
  await new Promise((r) => setTimeout(r, 2000));
  const docHash = await page.evaluate(() => location.hash);
  await page.evaluate(() => document.visibilityState); // settle
  await page.reload({ waitUntil: 'networkidle0' });
  await waitFor(page, () => document.querySelectorAll('.sent').length >= 4, 10_000, 'reader re-render');
  const resume = await page.evaluate(() => ({
    hash: location.hash,
    activeSent: document.querySelector('.sent.is-active')?.textContent ?? '',
  }));
  check(
    'reload resumes at saved position',
    resume.hash === docHash && resume.activeSent.length > 0 && !resume.activeSent.includes('quick brown fox'),
    `resumed at "${resume.activeSent.slice(0, 50)}"`,
  );

  // — cleanup the e2e doc
  const docId = docHash.replace('#/doc/', '');
  await page.evaluate((id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }), docId);

  // — playback rate takes effect on the FIRST chunk. Regression for the load()
  //   reset bug: a rate set before .load() was erased to 1× until the next gapless
  //   handoff. The rate must be set BEFORE the player mounts (it reads localStorage
  //   at construction); the rate UI text never reveals the bug, so assert the live
  //   active element's effective rate via the window.__lectern test hook.
  await page.evaluate(() => { location.hash = '#/'; });
  await waitFor(page, () => document.querySelector('[data-tab="text"]'), 8_000, 'library view (rate)');
  await page.evaluate(() => localStorage.setItem('lectern.rate', '2'));
  await page.click('[data-tab="text"]');
  await page.type('[data-form="text"] input[name="title"]', 'E2E Rate Doc');
  await page.type('[data-form="text"] textarea', TEXT);
  await page.click('[data-form="text"] .btn');
  await waitFor(page, () => location.hash.startsWith('#/doc/'), 10_000, 'rate reader route');
  await waitFor(page, () => document.querySelectorAll('.sent').length >= 4, 5_000, 'rate sentence spans');
  const rateHash = await page.evaluate(() => location.hash);

  const playClickAt = Date.now();
  await page.evaluate(() => document.getElementById('btn-play').click());
  await waitFor(
    page,
    () => document.getElementById('player').classList.contains('is-playing'),
    10_000,
    'rate doc playing state',
  );
  await waitFor(page, () => document.querySelector('.w.is-active'), 10_000, 'rate doc first word');
  const ttfaMs = Date.now() - playClickAt;

  const effectiveRate = await page.evaluate(() => window.__lectern?.activeRate ?? null);
  check('first chunk plays at the selected 2× rate', effectiveRate === 2, `active element playbackRate=${effectiveRate}`);
  check('time-to-first-audio (tuning log)', true, `${ttfaMs} ms from play click → first highlighted word`);

  // — first gapless handoff still holds at 2× (chunk 0's wall-clock halves, so the
  //   prefetch margin for chunk 1 is tighter than at 1×)
  const reachedPara2At2x = await waitFor(
    page,
    () => document.querySelector('.sent.is-active')?.textContent?.includes('Paragraph two') ?? false,
    30_000,
    'second chunk activation at 2×',
  ).catch(() => false);
  check('gapless chunk handoff holds at 2×', Boolean(reachedPara2At2x));

  await page.evaluate((id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }), rateHash.replace('#/doc/', ''));
  await page.evaluate(() => localStorage.setItem('lectern.rate', '1')); // restore default for later flows

  // — Supertonic on-device voice: a separate doc so it can't disturb the Edge
  //   flow above. Picks the voice in the real picker, plays, and asserts the
  //   karaoke highlight advances (proves the on-device synth round-tripped
  //   through /api/tts with word timings). Skips if the engine has no assets.
  await page.evaluate(() => { location.hash = '#/'; });
  await waitFor(page, () => document.querySelector('[data-tab="text"]'), 8_000, 'library view');
  await page.click('[data-tab="text"]');
  await page.type('[data-form="text"] input[name="title"]', 'E2E Supertonic Doc');
  await page.type(
    '[data-form="text"] textarea',
    'On device synthesis reads this sentence aloud. A second sentence follows so the highlight has room to move.',
  );
  await page.click('[data-form="text"] .btn');
  await waitFor(page, () => location.hash.startsWith('#/doc/'), 10_000, 'supertonic reader route');
  await waitFor(page, () => document.querySelectorAll('.sent').length >= 2, 5_000, 'supertonic sentence spans');
  const stHash = await page.evaluate(() => location.hash);
  const stVoice = await page.evaluate(() => {
    const sel = document.getElementById('voice-select');
    const opt = [...sel.options].find((o) => o.value.startsWith('supertonic:'));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    return opt.value;
  });
  if (!stVoice) {
    check('web: Supertonic voice available (SKIPPED — on-device assets absent)', true, 'skip');
  } else {
    await page.evaluate(() => document.getElementById('btn-play').click()); // fresh doc → wantPlay was false
    const stSeen = new Set();
    for (let i = 0; i < 60 && stSeen.size < 2; i++) {
      const w = await page.evaluate(() => document.querySelector('.w.is-active')?.textContent ?? '');
      if (w) stSeen.add(w);
      await new Promise((r) => setTimeout(r, 500));
    }
    check('web: Supertonic synthesizes + karaoke advances', stSeen.size >= 2, `${stVoice}, ${stSeen.size} words`);
  }
  await page.evaluate((id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }), stHash.replace('#/doc/', ''));

  // Kokoro on-device voice: same flow as Supertonic above, on its own doc.
  //   Word timings come from the model's phoneme durations, so the karaoke
  //   highlight must advance. Skips if the engine has no Kokoro assets.
  await page.evaluate(() => { location.hash = '#/'; });
  await waitFor(page, () => document.querySelector('[data-tab="text"]'), 8_000, 'library view');
  await page.click('[data-tab="text"]');
  await page.type('[data-form="text"] input[name="title"]', 'E2E Kokoro Doc');
  await page.type(
    '[data-form="text"] textarea',
    'Kokoro reads this sentence aloud on the device. A second sentence follows so the highlight has room to move.',
  );
  await page.click('[data-form="text"] .btn');
  await waitFor(page, () => location.hash.startsWith('#/doc/'), 10_000, 'kokoro reader route');
  await waitFor(page, () => document.querySelectorAll('.sent').length >= 2, 5_000, 'kokoro sentence spans');
  const kkHash = await page.evaluate(() => location.hash);
  const kkVoice = await page.evaluate(() => {
    const sel = document.getElementById('voice-select');
    const opt = [...sel.options].find((o) => o.value.startsWith('kokoro:'));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    return opt.value;
  });
  if (!kkVoice) {
    check('web: Kokoro voice available (SKIPPED — on-device assets absent)', true, 'skip');
  } else {
    await page.evaluate(() => document.getElementById('btn-play').click()); // fresh doc → wantPlay was false
    const kkSeen = new Set();
    for (let i = 0; i < 60 && kkSeen.size < 2; i++) {
      const w = await page.evaluate(() => document.querySelector('.w.is-active')?.textContent ?? '');
      if (w) kkSeen.add(w);
      await new Promise((r) => setTimeout(r, 500));
    }
    check('web: Kokoro synthesizes + karaoke advances', kkSeen.size >= 2, `${kkVoice}, ${kkSeen.size} words`);
  }
  await page.evaluate((id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }), kkHash.replace('#/doc/', ''));
} catch (err) {
  check('e2e run completed', false, err.message);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`);
process.exit(failed.length ? 1 : 0);
