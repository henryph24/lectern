// Lectern service worker — owns the (single) reading session, routes messages
// between the page engine (via bridge) and the offscreen audio document, and
// survives both its own idle termination and Chrome closing the offscreen doc
// after 30 s without audio (chrome.storage.session keeps the resume state).
const API = 'http://127.0.0.1:3000';
const DEFAULTS_KEY = 'lectern.defaults';

let session = null;
let sessionLoaded = false;
let lastPersist = 0;
// Tabs the user explicitly activated via a trusted entry point (toolbar click,
// context menu, keyboard command). Only these may start a reading session —
// see validUp() and the 'session-start' handler. An arm is spent by the
// session-start it authorizes, but not every gesture produces one (extraction
// can fail; a toolbar click can resolve to play/pause) — so arms also expire,
// rather than leaving a standing authorization the page could later spend on a
// forged session-start.
//
// The arm also carries a nonce, handed down to the document that received the
// gesture and echoed back in its session-start. A tab id alone is not an
// identity: within the 10 s TTL the tab can navigate, and the *next* document
// would otherwise inherit an unspent arm and start a session the user never
// authorized for it.
const ARM_TTL_MS = 10_000;
const armedTabs = new Map(); // tabId → { nonce, expiry }

function armTab(tabId) {
  const nonce = crypto.randomUUID();
  armedTabs.set(tabId, { nonce, expiry: Date.now() + ARM_TTL_MS });
  return nonce;
}

function consumeArm(tabId, nonce) {
  const arm = armedTabs.get(tabId);
  armedTabs.delete(tabId);
  return Boolean(arm) && arm.expiry > Date.now() && typeof nonce === 'string' && arm.nonce === nonce;
}

async function loadSession() {
  if (sessionLoaded) return;
  sessionLoaded = true;
  const stored = await chrome.storage.session.get('session');
  if (stored.session) session = stored.session;
}

function persistSession(force = false) {
  const now = Date.now();
  if (!force && now - lastPersist < 1000) return;
  lastPersist = now;
  if (session) chrome.storage.session.set({ session }).catch(() => {});
  else chrome.storage.session.remove('session').catch(() => {});
}

// The page picks a voice from the list we hand it, so the SW re-checks that a
// requested provider:voice is one the engine actually offers. Without this a
// page holding a session can rotate through arbitrary strings: every rotation
// misses the audio cache (the key includes the voice), re-synthesizes every
// chunk, and grows data/cache, which is never pruned by design. A bad string
// also persists as the global default and breaks every later read.
let voicesCache = null; // { at, payload, ids:Set<'provider:id'> }
const VOICES_TTL_MS = 5 * 60 * 1000;

async function fetchVoices() {
  if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL_MS) return voicesCache;
  const payload = await fetch(`${API}/api/voices`).then((r) => (r.ok ? r.json() : null));
  if (!payload) return null;
  const ids = new Set();
  for (const [provider, group] of Object.entries(payload)) {
    for (const v of group?.voices ?? []) if (typeof v?.id === 'string') ids.add(`${provider}:${v.id}`);
  }
  voicesCache = { at: Date.now(), payload, ids };
  return voicesCache;
}

async function voiceAllowed(provider, voice) {
  try {
    const cached = await fetchVoices();
    return Boolean(cached?.ids.has(`${provider}:${voice}`));
  } catch {
    return false;
  }
}

async function defaults() {
  const stored = await chrome.storage.local.get(DEFAULTS_KEY);
  return { provider: 'edge', voice: 'en-US-AvaMultilingualNeural', rate: 1, ...(stored[DEFAULTS_KEY] ?? {}) };
}

function saveDefaults(patch) {
  defaults().then((d) => chrome.storage.local.set({ [DEFAULTS_KEY]: { ...d, ...patch } }));
}

/* ——— messaging helpers ——— */

// Pushes are addressed to the *document* that owns the session wherever we know
// it. A tab id alone would deliver the session's words to whatever document the
// tab holds now, which after a navigation is a page that never saw the content.
function sendDown(payload, tabId = session?.tabId, { broadcast = false } = {}) {
  if (tabId == null) return;
  // `broadcast` is for the gesture hand-off only: 'begin' has to reach the
  // document the tab holds *now*, which is exactly the one the user gestured on.
  const target =
    !broadcast && session?.tabId === tabId && session?.documentId
      ? { documentId: session.documentId }
      : undefined;
  const sent = target
    ? chrome.tabs.sendMessage(tabId, { __lecternDown: true, payload }, target)
    : chrome.tabs.sendMessage(tabId, { __lecternDown: true, payload });
  sent.catch(() => {
    // the tab navigated away or closed — the session is over
    if (session?.tabId === tabId) stopSession();
  });
}

function sendOffscreen(msg) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Plays text-to-speech narration for the current page',
  });
}

/* ——— session lifecycle ——— */

async function stopSession() {
  session = null;
  persistSession(true);
  if (await hasOffscreen()) await sendOffscreen({ type: 'stop' });
}

// Tabs opened before the extension loaded have no content scripts; the
// action/menu click grants activeTab, so inject them on demand.
async function ensureContentScripts(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { __lecternPing: true });
    return true;
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/lectern.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/bridge.js'] });
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        files: ['content/extract-core.js', 'content/engine.js'],
      });
      return true;
    } catch {
      return false; // chrome:// pages, the Web Store, PDFs, etc.
    }
  }
}

function flashBadge(tabId, text) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#C8401F' }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 3000);
}

async function beginSession(tabId, mode) {
  await loadSession();
  if (session && session.tabId !== tabId) {
    sendDown({ type: 'teardown' }, session.tabId);
    await stopSession();
  }
  if (!(await ensureContentScripts(tabId))) return false;
  // Arm the tab: the engine will reply with 'session-start', which is only
  // honored for an armed tab (a forged drive-by session-start is ignored).
  const nonce = armTab(tabId);
  // hasSession lets the page resolve an 'auto' click to play/pause only when
  // there is still a session here to control — otherwise it re-reads.
  sendDown({ type: 'begin', mode, hasSession: session?.tabId === tabId, nonce }, tabId, { broadcast: true });
  return true;
}

// Every user entry point routes through here: hand the gesture to the page,
// and when the page can't take content scripts (chrome://, the Web Store, the
// PDF viewer) fall back to controlling the session we still own for that tab,
// so a click is never silently a no-op.
async function activate(tabId, mode) {
  if (await beginSession(tabId, mode)) return;
  if (session?.tabId === tabId) await togglePlayback();
  else flashBadge(tabId, '✕');
}

async function onSessionStart(tabId, { blocks }, sender) {
  try {
    // Re-reading the same tab (the page grew, or the user selected a passage):
    // silence the old narration now rather than letting it run on until the
    // new audio binds.
    if (session?.tabId === tabId && (await hasOffscreen())) await sendOffscreen({ type: 'stop' });
    const res = await fetch(`${API}/api/segment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Segmentation failed (${res.status})`);
    const { sentences, chunks } = await res.json();

    const prefs = await defaults();
    session = {
      tabId,
      // The document that received the user's gesture owns this session. Every
      // later control message must come from it, and every push goes to it.
      documentId: sender.documentId,
      // Title and URL come from the browser, never from the page's message: a
      // page that asserts its own provenance can plant a library entry titled
      // "Q3 Board Pack" sourced from a domain it does not own.
      ...(await provenance(tabId, sender)),
      blocks,
      chunkIdx: 0,
      inChunkMs: 0,
      ...prefs,
    };
    persistSession(true);

    let voices = null;
    try {
      voices = (await fetchVoices())?.payload ?? null;
    } catch {
      voices = null;
    }

    sendDown({
      type: 'segmented',
      sentences,
      chunks: chunks.map(({ text, ...meta }) => meta),
      voices,
      prefs,
    });

    await ensureOffscreen();
    await sendOffscreen({
      type: 'start',
      payload: {
        chunks: chunks.map((c) => ({ text: c.text })),
        startChunk: 0,
        provider: prefs.provider,
        voice: prefs.voice,
        rate: prefs.rate,
        autoplay: true,
      },
    });
  } catch (err) {
    sendDown(
      {
        type: 'error',
        message: `${err.message} — is the Lectern app running? (http://localhost:3000)`,
      },
      tabId,
    );
  }
}

async function provenance(tabId, sender) {
  const url = typeof sender?.url === 'string' ? sender.url.slice(0, 4000) : '';
  let title = '';
  try {
    title = (await chrome.tabs.get(tabId)).title ?? '';
  } catch {
    title = '';
  }
  if (!title) {
    try {
      title = new URL(url).hostname;
    } catch {
      title = 'Untitled page';
    }
  }
  return { title: title.slice(0, 2000), url };
}

// offscreen died (30 s paused) or SW restarted: rebuild playback at the saved position
async function rehydrateAndPlay() {
  if (!session) return;
  const res = await fetch(`${API}/api/segment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocks: session.blocks }),
  });
  if (!res.ok) throw new Error('Lectern engine unreachable');
  const { chunks } = await res.json();
  await ensureOffscreen();
  await sendOffscreen({
    type: 'start',
    payload: {
      chunks: chunks.map((c) => ({ text: c.text })),
      startChunk: session.chunkIdx,
      offsetMs: session.inChunkMs,
      provider: session.provider,
      voice: session.voice,
      rate: session.rate,
      autoplay: true,
    },
  });
}

async function togglePlayback() {
  await loadSession();
  if (!session) return;
  if (await hasOffscreen()) {
    sendOffscreen({ type: 'toggle' });
  } else {
    try {
      await rehydrateAndPlay();
    } catch (err) {
      sendDown({ type: 'error', message: err.message });
    }
  }
}

/* ——— inbound message validation ——— */

// engine.js runs in the page's MAIN world, so any page can post a forged "up"
// envelope through the bridge. The SW therefore treats every inbound message as
// untrusted: validate type/shape/bounds and drop anything unexpected before
// acting on it. (Bounds mirror the server-side caps in lib/limits.js.)
const MAX_UP_BLOCKS = 5000;
const MAX_BLOCK_CHARS = 50_000; // mirrors server/lib/limits.js
const MAX_TOTAL_CHARS = 2_000_000; // mirrors server/lib/limits.js
const MAX_CHUNK_IDX = 100_000;

function isUpBlocks(v) {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_UP_BLOCKS) return false;
  let total = 0;
  for (const b of v) {
    if (!b || typeof b.type !== 'string' || typeof b.text !== 'string') return false;
    if (b.text.length > MAX_BLOCK_CHARS) return false;
    total += b.text.length;
    if (total > MAX_TOTAL_CHARS) return false;
  }
  return true;
}

function validUp(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'session-start':
      // title/url are NOT taken from the page — see provenance().
      return isUpBlocks(msg.blocks) && typeof msg.nonce === 'string' && msg.nonce.length <= 64;
    case 'control':
      return typeof msg.action === 'string';
    case 'seek':
      return Number.isInteger(msg.chunkIdx) && msg.chunkIdx >= 0 && msg.chunkIdx <= MAX_CHUNK_IDX;
    case 'rate':
      return typeof msg.value === 'number' && msg.value > 0 && msg.value <= 4;
    case 'voice':
      return (
        typeof msg.provider === 'string' &&
        msg.provider.length <= 64 &&
        typeof msg.voice === 'string' &&
        msg.voice.length <= 256
      );
    case 'save-library':
    case 'session-end':
      return true;
    default:
      return false;
  }
}

/* ——— message routing ——— */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.__lecternUp && sender.tab?.id != null) {
    handleUp(sender.tab.id, msg.payload, sender);
    return;
  }
  if (msg?.target === 'sw') {
    handleOffscreen(msg, sender);
  }
});

// The session belongs to one document. A tab id is not an identity: the tab can
// navigate, and the next page would otherwise inherit the session — able to
// replay the previous page's words back to itself, save them to the library, or
// resume playback of content it never saw.
function ownsSession(tabId, sender) {
  return Boolean(session) && session.tabId === tabId && session.documentId === sender?.documentId;
}

async function handleUp(tabId, msg, sender) {
  if (!validUp(msg)) return;
  await loadSession();
  // One gate for every message that acts on a live session.
  if (msg.type !== 'session-start' && !ownsSession(tabId, sender)) return;
  switch (msg.type) {
    case 'session-start':
      // Only a document armed by a trusted user gesture may start a session; a
      // forged drive-by session-start is dropped here. Consume the arm so one
      // gesture authorizes exactly one session start, for exactly the document
      // that received the gesture.
      if (!consumeArm(tabId, msg.nonce)) break;
      await onSessionStart(tabId, msg, sender);
      break;
    case 'control':
      if (msg.action === 'toggle') await togglePlayback();
      break;
    case 'seek':
      if (!(await hasOffscreen())) {
        session.chunkIdx = msg.chunkIdx;
        session.inChunkMs = 0;
        persistSession(true);
        try {
          await rehydrateAndPlay();
        } catch (err) {
          sendDown({ type: 'error', message: err.message });
        }
        if (msg.charStart != null) sendOffscreen({ type: 'seek', chunkIdx: msg.chunkIdx, charStart: msg.charStart });
      } else {
        sendOffscreen({ type: 'seek', chunkIdx: msg.chunkIdx, charStart: msg.charStart ?? null });
      }
      break;
    case 'rate':
      saveDefaults({ rate: msg.value });
      session.rate = msg.value;
      persistSession(true);
      sendOffscreen({ type: 'rate', value: msg.value });
      break;
    case 'voice':
      // Only a provider:voice the engine actually offers, and at most one
      // switch a second: each switch re-synthesizes every chunk (the audio
      // cache is keyed by voice) and that cache is never pruned.
      if (!(await voiceAllowed(msg.provider, msg.voice))) break;
      if (Date.now() - (session.lastVoiceAt ?? 0) < 1000) break;
      session.lastVoiceAt = Date.now();
      saveDefaults({ provider: msg.provider, voice: msg.voice });
      session.provider = msg.provider;
      session.voice = msg.voice;
      persistSession(true);
      if (await hasOffscreen()) {
        sendOffscreen({ type: 'voice', provider: msg.provider, voice: msg.voice });
      }
      break;
    case 'save-library':
      // One save per session: the save button lives in the page's own world, so
      // a page holding a session could otherwise write the library full.
      if (session.saved) break;
      session.saved = true;
      try {
        const res = await fetch(`${API}/api/docs/import/blocks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: session.title,
            source: { type: 'url', value: session.url },
            blocks: session.blocks,
          }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Save failed');
        persistSession(true);
        sendDown({ type: 'saved' });
      } catch (err) {
        if (session) session.saved = false; // a failed save may be retried
        sendDown({ type: 'error', message: err.message });
      }
      break;
    case 'session-end':
      await stopSession();
      break;
  }
}

function handleOffscreen(msg, sender) {
  // Only our own offscreen document; nothing else in the extension speaks this
  // protocol, and a content script must never be able to.
  if (sender?.url !== chrome.runtime.getURL('offscreen.html')) return;
  if (!session) return;
  switch (msg.type) {
    case 'time':
      session.chunkIdx = msg.idx;
      session.inChunkMs = msg.ms;
      persistSession();
      sendDown({ type: 'time', idx: msg.idx, ms: msg.ms, rate: msg.rate, playing: msg.playing });
      break;
    case 'chunk-start':
      session.chunkIdx = msg.idx;
      session.inChunkMs = 0;
      persistSession();
      sendDown({ type: 'chunk', idx: msg.idx, words: msg.words });
      break;
    case 'state':
      sendDown({ type: 'state', state: msg.state, message: msg.message, rate: msg.rate });
      break;
  }
}

/* ——— user entry points ——— */

// The toolbar icon means "read this", not "play/pause": the page resolves an
// 'auto' click against its live DOM — a selection, content that arrived since
// we extracted (SPA answers, feed items), or nothing new, in which case the
// engine asks for a toggle itself.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  await activate(tab.id, 'auto');
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'lectern-selection',
    title: 'Lectern: read selection',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: 'lectern-from-here',
    title: 'Lectern: read from here',
    contexts: ['page', 'selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === 'lectern-selection') await activate(tab.id, 'selection');
  if (info.menuItemId === 'lectern-from-here') await activate(tab.id, 'caret');
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-playback') await togglePlayback();
});

// A document load in the reading tab ends the session: the content is gone, and
// the incoming document must not inherit either the session or an unspent arm.
// (SPA route changes do not report 'loading', so in-page navigation survives.)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  armedTabs.delete(tabId);
  await loadSession();
  if (session?.tabId === tabId) await stopSession();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  armedTabs.delete(tabId);
  await loadSession();
  if (session?.tabId === tabId) await stopSession();
});

// e2e hooks: drive the same code paths as toolbar clicks / shortcuts.
// No lastFocusedWindow filter — headless CI windows often report no focus.
async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true });
  const tab = tabs.find((t) => t.url?.startsWith('http')) ?? tabs[0];
  return tab?.id ?? null;
}
globalThis.__lecternStart = async (mode = 'page', tabId = null) => {
  const target = tabId ?? (await activeTabId());
  if (target == null) throw new Error('lectern e2e hook: no active tab found');
  if (!(await beginSession(target, mode))) {
    throw new Error(`lectern e2e hook: content scripts not injectable into tab ${target}`);
  }
  return target;
};
globalThis.__lecternToggle = () => togglePlayback();
globalThis.__lecternState = async () => {
  await loadSession();
  return {
    session: session ? { ...session, blocks: session.blocks.length } : null,
    offscreen: await hasOffscreen(),
  };
};
