import { api } from './api.js';
import { renderReader } from './reader.js';
import { createPlayer } from './player.js';

const VOICE_KEY = 'lectern.voice';
const view = document.getElementById('view');
const playerBar = document.getElementById('player');
const voiceSelect = document.getElementById('voice-select');

const playerEls = {
  player: playerBar,
  btnPlay: document.getElementById('btn-play'),
  btnPrev: document.getElementById('btn-prev'),
  btnNext: document.getElementById('btn-next'),
  rateDown: document.getElementById('rate-down'),
  rateUp: document.getElementById('rate-up'),
  rateValue: document.getElementById('rate-value'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progress-fill'),
  timeElapsed: document.getElementById('time-elapsed'),
  timeRemaining: document.getElementById('time-remaining'),
  playerTitle: document.getElementById('player-title'),
};

let player = null;
let readerView = null;

/* ——— toasts ——— */

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' is-error' : ''}`;
  el.textContent = message;
  el.onclick = () => dismiss();
  document.getElementById('toasts').appendChild(el);
  const timer = setTimeout(dismiss, 6000);
  function dismiss() {
    clearTimeout(timer);
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 260);
  }
}

/* ——— voices ——— */

async function loadVoices() {
  let voicesData;
  try {
    voicesData = await api.voices();
  } catch (err) {
    toast(`Could not load voices: ${err.message}`, 'error');
    voicesData = { edge: { voices: [], default: 'en-US-AvaMultilingualNeural' }, elevenlabs: { available: false, voices: [] }, supertonic: { available: false, voices: [] }, kokoro: { available: false, voices: [] } };
  }

  voiceSelect.innerHTML = '';
  const edgeGroup = document.createElement('optgroup');
  edgeGroup.label = 'Edge — free';
  for (const v of voicesData.edge.voices) {
    edgeGroup.appendChild(option(`edge:${v.id}`, v.label));
  }
  voiceSelect.appendChild(edgeGroup);

  if (voicesData.elevenlabs.available && voicesData.elevenlabs.voices.length) {
    const elGroup = document.createElement('optgroup');
    elGroup.label = 'ElevenLabs';
    for (const v of voicesData.elevenlabs.voices) {
      elGroup.appendChild(option(`elevenlabs:${v.id}`, v.label));
    }
    voiceSelect.appendChild(elGroup);
  }

  if (voicesData.supertonic?.available && voicesData.supertonic.voices.length) {
    const stGroup = document.createElement('optgroup');
    stGroup.label = 'Supertonic — on-device';
    for (const v of voicesData.supertonic.voices) {
      stGroup.appendChild(option(`supertonic:${v.id}`, v.label));
    }
    voiceSelect.appendChild(stGroup);
  }

  if (voicesData.kokoro?.available && voicesData.kokoro.voices.length) {
    const kkGroup = document.createElement('optgroup');
    kkGroup.label = 'Kokoro — on-device';
    for (const v of voicesData.kokoro.voices) {
      kkGroup.appendChild(option(`kokoro:${v.id}`, v.label));
    }
    voiceSelect.appendChild(kkGroup);
  }

  const stored = localStorage.getItem(VOICE_KEY);
  if (stored && [...voiceSelect.options].some((o) => o.value === stored)) {
    voiceSelect.value = stored;
  } else {
    voiceSelect.value = `edge:${voicesData.edge.default}`;
  }
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function currentVoice() {
  const [provider, ...rest] = voiceSelect.value.split(':');
  return { provider, id: rest.join(':') };
}

voiceSelect.addEventListener('change', () => {
  localStorage.setItem(VOICE_KEY, voiceSelect.value);
  const v = currentVoice();
  player?.setVoice(v.provider, v.id);
});

/* ——— routing ——— */

window.addEventListener('hashchange', route);

function route() {
  player?.dispose();
  player = null;
  readerView?.dispose();
  readerView = null;
  playerBar.classList.add('is-hidden');
  view.innerHTML = '';

  const hash = location.hash || '#/';
  const docMatch = hash.startsWith('#/doc/') ? hash.slice('#/doc/'.length) : null;
  let id = null;
  if (docMatch) {
    try {
      id = decodeURIComponent(docMatch);
    } catch {
      id = null; // malformed escape, e.g. #/doc/% — fall back to the library
    }
  }
  if (id) renderReaderView(id, hash);
  else renderLibraryView();
}

// A plain object literal would resolve 'constructor'/'toString' from the
// prototype for a document whose source.type is attacker-shaped.
const SOURCE_LABELS = new Map([
  ['url', 'web'],
  ['pdf', 'pdf'],
  ['text', 'pasted'],
]);

/* ——— library view ——— */

async function renderLibraryView() {
  view.innerHTML = `
    <section class="add-panel">
      <div class="add-tabs" role="tablist">
        <button class="add-tab is-active" data-tab="url">Web page</button>
        <button class="add-tab" data-tab="pdf">PDF</button>
        <button class="add-tab" data-tab="text">Paste text</button>
      </div>
      <form class="add-form is-active" data-form="url">
        <input class="field" type="url" name="url" placeholder="https:// paste an article URL" required>
        <button class="btn" type="submit">Listen</button>
      </form>
      <form class="add-form col" data-form="pdf">
        <div class="dropzone" tabindex="0">Drop a PDF here, or <strong>browse</strong></div>
        <input type="file" accept="application/pdf,.pdf" hidden>
      </form>
      <form class="add-form col" data-form="text">
        <input class="field" type="text" name="title" placeholder="Title (optional)">
        <textarea class="field" name="text" placeholder="Paste anything — it becomes listenable." required></textarea>
        <button class="btn" type="submit">Listen</button>
      </form>
    </section>
    <h2 class="lib-heading">Your library</h2>
    <ul class="lib-list"></ul>
  `;

  wireTabs();
  wireUrlForm();
  wirePdfForm();
  wireTextForm();
  await renderLibraryList();
}

function wireTabs() {
  const tabs = view.querySelectorAll('.add-tab');
  tabs.forEach((tab) =>
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.toggle('is-active', t === tab));
      view.querySelectorAll('.add-form').forEach((f) =>
        f.classList.toggle('is-active', f.dataset.form === tab.dataset.tab),
      );
    }),
  );
}

function switchToPasteTab() {
  view.querySelector('[data-tab="text"]')?.click();
  view.querySelector('[data-form="text"] textarea')?.focus();
}

function openDoc(doc) {
  location.hash = `#/doc/${doc.id}`;
}

function busy(button, on) {
  if (!button) return;
  button.disabled = on;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = 'Working…';
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
}

function wireUrlForm() {
  const form = view.querySelector('[data-form="url"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.btn');
    busy(btn, true);
    try {
      openDoc(await api.importUrl(form.url.value.trim()));
    } catch (err) {
      toast(err.message, 'error');
      if (err.suggestPasteText) {
        toast('Tip: copy the article text and use the Paste tab instead.');
        switchToPasteTab();
      }
    } finally {
      busy(btn, false);
    }
  });
}

function wirePdfForm() {
  const form = view.querySelector('[data-form="pdf"]');
  const zone = form.querySelector('.dropzone');
  const input = form.querySelector('input[type="file"]');

  const openPicker = () => input.click();
  zone.addEventListener('click', openPicker);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-over');
    const file = e.dataTransfer.files?.[0];
    if (file) handlePdf(file);
  });
  input.addEventListener('change', () => {
    if (input.files?.[0]) handlePdf(input.files[0]);
  });

  async function handlePdf(file) {
    zone.textContent = `Reading ${file.name}…`;
    try {
      openDoc(await api.importPdf(file));
    } catch (err) {
      toast(err.message, 'error');
      zone.innerHTML = 'Drop a PDF here, or <strong>browse</strong>';
    }
  }
}

function wireTextForm() {
  const form = view.querySelector('[data-form="text"]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('.btn');
    busy(btn, true);
    try {
      openDoc(await api.importText(form.text.value, form.title.value.trim() || undefined));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(btn, false);
    }
  });
}

async function renderLibraryList() {
  const list = view.querySelector('.lib-list');
  let docs;
  try {
    docs = await api.listDocs();
  } catch (err) {
    toast(`Could not load library: ${err.message}`, 'error');
    return;
  }

  if (docs.length === 0) {
    list.insertAdjacentHTML(
      'afterend',
      '<p class="empty-state">Nothing on the lectern yet.<br>Add something above to start listening.</p>',
    );
    return;
  }

  docs.forEach((doc, i) => {
    const li = document.createElement('li');
    li.className = 'lib-row';
    li.style.setProperty('--i', i);

    const minutes = Math.max(1, Math.round((doc.charCount * 60) / 60000));
    const progress = doc.chunkCount > 1 ? Math.round((doc.position.chunkIdx / (doc.chunkCount - 1)) * 100) : 0;
    const sourceLabel = SOURCE_LABELS[doc.source?.type] ?? 'doc';

    const main = document.createElement('div');
    main.className = 'lib-main';
    const title = document.createElement('h3');
    title.className = 'lib-title';
    title.textContent = doc.title;
    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    const span = (text, cls) => {
      const el = document.createElement('span');
      el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
    meta.append(span(sourceLabel), span(`≈ ${minutes} min`));
    if (progress > 0) meta.append(span(`${progress}%`, 'lib-progress'));
    main.append(title, meta);

    const del = document.createElement('button');
    del.className = 'lib-delete';
    del.title = 'Remove from library';
    del.setAttribute('aria-label', `Delete ${doc.title}`);
    del.textContent = '✕';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await api.deleteDoc(doc.id);
        li.remove();
        toast('Removed from library');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    li.append(main, del);
    li.addEventListener('click', () => {
      location.hash = `#/doc/${doc.id}`;
    });
    list.appendChild(li);
  });
}

/* ——— reader view ——— */

async function renderReaderView(id, routeHash = location.hash) {
  let doc;
  try {
    doc = await api.getDoc(id);
  } catch {
    if (location.hash !== routeHash) return;
    toast('That document is gone.', 'error');
    location.hash = '#/';
    return;
  }
  // The user can navigate away while the document loads. Without this the
  // orphaned reader mounts on the library page and its player keeps saving
  // positions for a document that is no longer open.
  if (location.hash !== routeHash) return;

  const top = document.createElement('div');
  top.className = 'reader-top';
  const minutes = Math.max(1, Math.round((doc.blocks.reduce((n, b) => n + b.text.length, 0) * 60) / 60000));
  const metaParts = [
    doc.byline,
    doc.source?.type === 'url' ? safeHostname(doc.source.value) : doc.source?.type,
    `≈ ${minutes} min listen`,
  ].filter(Boolean);
  top.innerHTML = `
    <div class="reader-top-row">
      <a class="back-link" href="#/">← Library</a>
      <button id="toc-btn" class="toc-btn is-hidden" aria-expanded="false">Contents</button>
    </div>
    <div class="doc-meta">${metaParts.map((p) => `<span>${escapeHtml(String(p))}</span>`).join('')}</div>
  `;
  view.appendChild(top);

  readerView = renderReader(view, doc);

  const hints = document.createElement('div');
  hints.className = 'kbd-hints';
  hints.innerHTML = `
    <span><kbd>space</kbd>play / pause</span>
    <span><kbd>←</kbd><kbd>→</kbd>sentence</span>
    <span><kbd>−</kbd><kbd>+</kbd>speed</span>
    <span>click any sentence to jump</span>
  `;
  view.appendChild(hints);

  playerBar.classList.remove('is-hidden');
  player = createPlayer({
    doc,
    reader: readerView,
    els: playerEls,
    voice: currentVoice(),
    onError: (err) => toast(err.message, 'error'),
  });

  wireToc(doc, top.querySelector('#toc-btn'));
}

/* ——— contents (headings, else page markers) ——— */

function buildToc(doc) {
  const firstSentenceOfBlock = new Map();
  doc.sentences.forEach((s, si) => {
    if (!firstSentenceOfBlock.has(s.block)) firstSentenceOfBlock.set(s.block, si);
  });

  const headings = [];
  doc.blocks.forEach((b, bi) => {
    if ((b.type === 'h1' || b.type === 'h2' || b.type === 'h3') && firstSentenceOfBlock.has(bi)) {
      headings.push({ label: b.text, level: b.type, si: firstSentenceOfBlock.get(bi) });
    }
  });
  if (headings.length >= 2) return headings;

  const pages = [];
  let lastPage = null;
  doc.blocks.forEach((b, bi) => {
    if (b.page && b.page !== lastPage && firstSentenceOfBlock.has(bi)) {
      pages.push({ label: `Page ${b.page}`, level: 'h3', si: firstSentenceOfBlock.get(bi) });
      lastPage = b.page;
    }
  });
  return pages.length > 1 ? pages : null;
}

function wireToc(doc, btn) {
  const entries = buildToc(doc);
  if (!entries) return;
  btn.classList.remove('is-hidden');

  const panel = document.createElement('div');
  panel.className = 'toc-panel is-hidden';
  for (const entry of entries) {
    const item = document.createElement('button');
    item.className = `toc-item toc-${entry.level}`;
    item.textContent = entry.label;
    item.addEventListener('click', () => {
      player?.seekToSentence(entry.si);
      close();
    });
    panel.appendChild(item);
  }
  btn.insertAdjacentElement('afterend', panel);

  function close() {
    panel.classList.add('is-hidden');
    btn.setAttribute('aria-expanded', 'false');
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.classList.toggle('is-hidden');
    btn.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('is-hidden') && !panel.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/* ——— boot ——— */

// The desktop shell hides its title bar, so the masthead becomes the drag
// strip and must clear the traffic lights (see .is-desktop in style.css).
if (navigator.userAgent.includes('Electron')) document.documentElement.classList.add('is-desktop');

await loadVoices();
route();
