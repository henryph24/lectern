// Lectern desktop shell: runs the existing Express engine inside Electron's
// main process and shows the web UI in a window. While the app is open, the
// same engine serves the Chrome extension and any browser on localhost:3000.
import { app, BrowserWindow, dialog, shell } from 'electron';
import { readFileSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineToken } from '../server/lib/engine-token.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const PORT = Number(process.env.PORT ?? 3000);
const BASE = `http://127.0.0.1:${PORT}`;
const ENGINE_ORIGIN = new URL(BASE).origin;
// mirrors SAFE_ID in server/lib/store.js — ids the store will actually serve
const SAFE_DOC_ID = /^[a-z0-9-]+$/;

// Our own version, read from the package.json that ships next to server/ (in
// the repo and inside the asar alike). NOT app.getVersion(): in a dev run
// (`electron desktop/main.mjs`) that reports Electron's version, which would
// make the engine comparison below meaningless.
const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
})();

// e2e isolation: a private userData gives the test instance its own
// single-instance lock (and data dir), so it can run beside the real app
if (process.env.LECTERN_USER_DATA) {
  app.setPath('userData', process.env.LECTERN_USER_DATA);
}

let mainWindow = null;
let engineReady = false;
const pendingFiles = [];

// fires before 'ready' when the app is launched by double-clicking a PDF
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  pendingFiles.push(filePath);
  if (engineReady) drainPendingFiles();
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(boot);
}

async function boot() {
  const ok = await startEngine();
  if (!ok) return;
  engineReady = true;
  createWindow();
  await drainPendingFiles();
}

async function startEngine() {
  const dataDir = app.isPackaged
    ? path.join(app.getPath('userData'), 'data')
    : path.join(repoRoot, 'data');
  const envFile = app.isPackaged
    ? path.join(app.getPath('userData'), '.env')
    : path.join(repoRoot, '.env');
  try {
    process.loadEnvFile(envFile);
  } catch {
    // no .env — Edge TTS needs no configuration
  }

  // OCR caches downloaded traineddata to disk; in a packaged app the asar is
  // read-only, so point it at the writable data dir (mirrors SUPERTONIC_DIR).
  process.env.OCR_CACHE_DIR ??= path.join(dataDir, 'ocr-cache');

  const { createApp } = await import('../server/app.js');
  const result = await new Promise((resolve) => {
    const server = createApp({ dataDir }).listen(PORT, '127.0.0.1');
    server.on('listening', () => resolve('started'));
    server.on('error', (err) => resolve(err.code === 'EADDRINUSE' ? 'busy' : 'failed'));
  });

  if (result === 'started') return true;
  if (result === 'busy') {
    // Another process already holds the port. It may be a Lectern engine we
    // should share (npm start / a previous instance / the launchd agent) — or
    // anything else that got there first. Prove it before adopting it.
    const probe = await probeRunningEngine();
    if (probe.ok) return true;
    dialog.showErrorBox('Lectern', portHolderMessage(probe));
    app.quit();
    return false;
  }
  dialog.showErrorBox('Lectern', 'The Lectern engine failed to start.');
  app.quit();
  return false;
}

// Adopting the port holder means handing it everything: mainWindow renders its
// HTML in a chromeless branded window, dragged-in PDFs are POSTed to it as raw
// bytes, and the extension talks to the same fixed address. A bare 200 is not
// evidence, so the holder must clear three bars: demand authentication, accept
// this user's engine token, and report a version at least as new as this app
// (an older engine may predate a security fix, and silently reusing it would
// keep the patched build sidelined forever).
//
// Residual: no HTTP response can prove the holder KNOWS the token, so a process
// deliberately mimicking this exchange still passes — but that process runs as
// this user, and could read the 0600 token file anyway. What the token does
// stop is every caller that cannot read that file: another account, a sandboxed
// app, and any website the browser points at the port.
async function probeRunningEngine() {
  const token = readEngineToken();
  if (!token) return { ok: false, reason: 'unverifiable' };
  let body;
  try {
    // Step 1 — the holder must DEMAND authentication. A squatter that answers
    // 200 to everything fails here, and never gets handed our token.
    const challenge = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (challenge.status !== 401) return { ok: false, reason: 'unverifiable' };

    // Step 2 — and it must accept the token this user's engine wrote.
    const res = await fetch(`${BASE}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, reason: 'unverifiable' };
    body = await res.json();
  } catch {
    return { ok: false, reason: 'unverifiable' };
  }
  if (!body || body.name !== 'lectern') return { ok: false, reason: 'unverifiable' };

  const theirs = parseVersion(body.version);
  const ours = parseVersion(APP_VERSION);
  // ours === null only if our own package.json is unreadable; there is nothing
  // to compare against then, and the token already proved identity.
  if (ours && (!theirs || compareVersions(theirs, ours) < 0)) {
    return { ok: false, reason: 'stale', version: body.version };
  }
  return { ok: true, version: body.version };
}

function portHolderMessage(probe) {
  if (probe.reason === 'stale') {
    return (
      `Port ${PORT} is served by an older Lectern engine (version ${probe.version}; ` +
      `this app is ${APP_VERSION}), which may be missing security fixes.\n\n` +
      'Quit the old Lectern engine (or run "launchctl bootout ' +
      'gui/$(id -u)/dev.hungpq.lectern.engine"), then reopen Lectern.'
    );
  }
  return (
    `Port ${PORT} is in use by another application that is not this user's Lectern ` +
    'engine, so the Lectern engine cannot start.\n\n' +
    'Quit whatever is using the port, then reopen Lectern.'
  );
}

// Dotted numeric version → number[]; null for anything else. A pre-release or
// build suffix ("1.2.0-rc.1", "1.2.0+sha") compares as its release.
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const core = value.trim().split('+')[0].split('-')[0];
  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const numbers = [];
  for (const part of parts) {
    const n = Number(part);
    if (part.length === 0 || !Number.isInteger(n) || n < 0) return null;
    numbers.push(n);
  }
  while (numbers.length < 3) numbers.push(0);
  return numbers;
}

// -1 / 0 / 1, comparing segment by segment (missing segments count as 0).
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 760,
    minHeight: 520,
    title: 'Lectern',
    backgroundColor: '#f4eee1',
    // Stated explicitly (all are today's defaults) so a future Electron major
    // cannot quietly change the posture: the renderer is a plain web client of
    // the local engine and needs no Node, no shared context, no relaxed
    // same-origin policy.
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow.loadURL(BASE);
  applyNavigationPolicy(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// The window is chromeless and branded: whatever it renders looks like Lectern.
// Keep it pinned to the engine origin — a link, a redirect or a popup must
// never repaint this frame with someone else's page.
function applyNavigationPolicy(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // no second Electron window ever; ordinary web links go to the browser
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {
      // unparseable → not the engine
    }
    if (origin !== ENGINE_ORIGIN) {
      event.preventDefault();
      console.warn(`Lectern: blocked navigation away from the engine origin → ${url}`);
    }
  });

  // no <webview> in the app; refuse the tag outright rather than sanitizing it
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

async function drainPendingFiles() {
  while (pendingFiles.length > 0) {
    const filePath = pendingFiles.shift();
    const name = path.basename(filePath);
    try {
      const { lstat, readFile } = await import('node:fs/promises');
      // lstat, not stat: readFile() follows symlinks, so a "report.pdf" that
      // links to ~/.ssh/id_rsa would be slurped up and POSTed into the library.
      const info = await lstat(filePath);
      if (info.isSymbolicLink()) {
        console.warn(`Lectern: refusing to open "${name}" — it is a symbolic link.`);
        throw new Error(
          `"${name}" is a symbolic link, so it was not opened. Open the file it points to directly.`,
        );
      }
      if (!info.isFile()) throw new Error(`"${name}" is not a regular file.`);
      // O_NOFOLLOW closes the gap between the check above and the open below
      // (not available on every platform — fall back to the lstat result).
      const bytes = await readFile(filePath, {
        flag: fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      });
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
      const res = await fetch(`${BASE}/api/docs/import/pdf`, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Import failed (${res.status})`);
      // the id is interpolated into a URL this window then loads — accept only
      // the shape the store itself accepts
      if (typeof body.id !== 'string' || !SAFE_DOC_ID.test(body.id)) {
        throw new Error('The engine returned an unrecognized document id.');
      }
      if (!mainWindow) createWindow();
      await mainWindow.loadURL(`${BASE}/#/doc/${body.id}`);
      mainWindow.show();
      mainWindow.focus();
    } catch (err) {
      dialog.showErrorBox('Lectern — PDF import failed', err.message);
    }
  }
}

// keep the engine alive with the window closed (extension + browser keep
// working); the dock icon re-opens the window
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (engineReady && !mainWindow) createWindow();
});
