const json = { 'Content-Type': 'application/json' };

async function handle(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = body.code;
    err.suggestPasteText = Boolean(body.suggestPasteText);
    throw err;
  }
  return body;
}

export const api = {
  importUrl: (url) =>
    fetch('/api/docs/import/url', { method: 'POST', headers: json, body: JSON.stringify({ url }) }).then(handle),

  importText: (text, title) =>
    fetch('/api/docs/import/text', { method: 'POST', headers: json, body: JSON.stringify({ text, title }) }).then(handle),

  importPdf: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch('/api/docs/import/pdf', { method: 'POST', body: form }).then(handle);
  },

  voices: () => fetch('/api/voices').then(handle),

  tts: (provider, voice, text, { signal } = {}) =>
    fetch('/api/tts', { method: 'POST', headers: json, body: JSON.stringify({ provider, voice, text }), signal }).then(handle),

  listDocs: () => fetch('/api/docs').then(handle),

  getDoc: (id) => fetch(`/api/docs/${encodeURIComponent(id)}`).then(handle),

  deleteDoc: (id) => fetch(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(handle),

  savePosition: (id, position) =>
    fetch(`/api/docs/${encodeURIComponent(id)}/position`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify(position),
      keepalive: true,
    }).then(handle),
};
