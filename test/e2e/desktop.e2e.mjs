// Desktop end-to-end: boots the Electron app (packaged build if present, dev
// otherwise) with remote debugging, connects puppeteer, and smokes the full
// loop: window loads the UI → import a doc → play → clock advances.
//
//   npm run e2e:desktop
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { makeScannedPdf } from '../fixtures/scanned-pdf.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// LECTERN_APP can point at any Lectern binary (e.g. an unzipped release asset)
const PACKAGED =
  process.env.LECTERN_APP ??
  path.join(root, 'dist', 'mac-arm64', 'Lectern.app', 'Contents', 'MacOS', 'Lectern');
const DEBUG_PORT = 9557;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`Timed out: ${label}`);
}

const usePackaged = existsSync(PACKAGED) && !process.env.LECTERN_E2E_DEV;
const [cmd, args] = usePackaged
  ? [PACKAGED, [`--remote-debugging-port=${DEBUG_PORT}`]]
  : ['npx', ['electron', 'desktop/main.mjs', `--remote-debugging-port=${DEBUG_PORT}`]];
console.log(`launching ${usePackaged ? 'packaged Lectern.app' : 'dev electron'}…`);
// private userData → own single-instance lock + data dir, so the test can
// run while the real Lectern.app is open
const child = spawn(cmd, args, {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, LECTERN_USER_DATA: mkdtempSync(path.join(tmpdir(), 'lectern-e2e-')) },
});
let appOutput = '';
const collect = (buf) => {
  appOutput = (appOutput + buf.toString()).slice(-4000);
};
child.stdout.on('data', collect);
child.stderr.on('data', collect);

let browser = null;
const consoleTail = [];
try {
  browser = await poll(
    () => puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null }),
    20_000,
    'CDP connection to Electron',
  );
  check('electron app starts with remote debugging', true);

  const pageTarget = await poll(async () => {
    const targets = browser.targets();
    return targets.find((t) => t.type() === 'page' && t.url().includes('127.0.0.1:3000')) ?? null;
  }, 15_000, 'app window');
  const page = await pageTarget.page();
  page.on('console', (m) => {
    consoleTail.push(m.text());
    if (consoleTail.length > 30) consoleTail.shift();
  });
  await poll(() => page.evaluate(() => document.querySelector('.lib-heading, .empty-state') !== null), 15_000, 'library view');
  check('window renders the Lectern library', true);

  // import a short doc through the UI form (DOM-driven — no hit-testing,
  // which flakes inside Electron under xvfb)
  await page.evaluate(() => {
    document.querySelector('[data-tab="text"]').click();
    document.querySelector('[data-form="text"] textarea').value =
      'Desktop smoke test sentence one. And sentence two follows here.';
    document.querySelector('[data-form="text"]').requestSubmit();
  });
  await poll(() => page.evaluate(() => location.hash.startsWith('#/doc/')), 15_000, 'reader route');
  check('paste import opens the reader', true);

  await page.evaluate(() => document.getElementById('btn-play').click());
  const elapsed = await poll(
    () =>
      page.evaluate(() => {
        const t = document.getElementById('time-elapsed')?.textContent;
        return t && t !== '0:00' ? t : null;
      }),
    20_000,
    'playback clock',
  );
  check('playback clock advances in the desktop app', Boolean(elapsed), elapsed);

  const word = await page.evaluate(() => document.querySelector('.w.is-active')?.textContent ?? null);
  check('karaoke highlight active', Boolean(word), `word "${word}"`);

  // — Supertonic on-device voice (same web client + the in-process desktop
  //   engine). Already playing, so switching the picker re-synthesizes the
  //   current chunk on-device and playback continues. Skips if no assets.
  const stVoice = await page.evaluate(() => {
    const sel = document.getElementById('voice-select');
    const opt = sel && [...sel.options].find((o) => o.value.startsWith('supertonic:'));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    return opt.value;
  });
  if (!stVoice) {
    check('desktop: Supertonic voice available (SKIPPED — on-device assets absent)', true, 'skip');
  } else {
    const stSeen = new Set();
    for (let i = 0; i < 60 && stSeen.size < 2; i++) {
      const w = await page.evaluate(() => document.querySelector('.w.is-active')?.textContent ?? '');
      if (w) stSeen.add(w);
      await sleep(500);
    }
    check('desktop: Supertonic synthesizes + karaoke advances', stSeen.size >= 2, `${stVoice}, ${stSeen.size} words`);
  }

  // Kokoro on-device voice, same switch-while-playing flow as Supertonic
  //   above. Skips if the engine has no Kokoro assets.
  const kkVoice = await page.evaluate(() => {
    const sel = document.getElementById('voice-select');
    const opt = sel && [...sel.options].find((o) => o.value.startsWith('kokoro:'));
    if (!opt) return null;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change'));
    return opt.value;
  });
  if (!kkVoice) {
    check('desktop: Kokoro voice available (SKIPPED — on-device assets absent)', true, 'skip');
  } else {
    const kkSeen = new Set();
    for (let i = 0; i < 60 && kkSeen.size < 2; i++) {
      const w = await page.evaluate(() => document.querySelector('.w.is-active')?.textContent ?? '');
      if (w) kkSeen.add(w);
      await sleep(500);
    }
    check('desktop: Kokoro synthesizes + karaoke advances', kkSeen.size >= 2, `${kkVoice}, ${kkSeen.size} words`);
  }

  // — OCR: import a scanned (image-only) PDF through the packaged engine. This
  //   is the only check that exercises the bundled @napi-rs/canvas + tesseract.js
  //   loading from app.asar.unpacked — the packaging risk dev mode can't catch.
  try {
    const pdf = await makeScannedPdf([
      'The quick brown fox jumps over the lazy dog.',
      'OCR works in the packaged Lectern app.',
    ]);
    const recovered = await page.evaluate(async (bytes) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'scanned.pdf');
      const res = await fetch('/api/docs/import/pdf', { method: 'POST', body: form });
      const doc = await res.json().catch(() => ({}));
      if (doc.id) await fetch(`/api/docs/${doc.id}`, { method: 'DELETE' });
      return { status: res.status, text: (doc.blocks ?? []).map((b) => b.text).join(' ') };
    }, [...pdf]);
    const ok = recovered.status === 201 && /quick brown fox/i.test(recovered.text);
    check('desktop: OCR recovers a scanned PDF (packaged canvas + tesseract)', ok, `status ${recovered.status}`);
  } catch (err) {
    check('desktop: OCR recovers a scanned PDF (packaged canvas + tesseract)', false, err.message);
  }

  // cleanup the smoke doc via the app's own API
  const docId = await page.evaluate(() => location.hash.replace('#/doc/', ''));
  await page.evaluate((id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }), docId);
} catch (err) {
  check('desktop e2e completed', false, err.message);
  if (appOutput) console.error(`--- electron output (tail) ---\n${appOutput}\n-------------------------------`);
  if (consoleTail.length) {
    console.error(`--- renderer console (tail) ---\n${consoleTail.join('\n')}\n-------------------------------`);
  }
} finally {
  if (browser) browser.disconnect();
  child.kill('SIGTERM');
  await sleep(500);
  if (!child.killed) child.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} desktop e2e checks passed`);
process.exit(failed.length ? 1 : 0);
