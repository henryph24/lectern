// Isolated-world bridge: the MAIN-world engine has no chrome.* APIs, so it
// talks through window.postMessage; we relay to/from the service worker with
// one-off messages (no persistent port — the SW detects a dead tab when its
// next push fails).
(() => {
  // injected both statically (manifest) and dynamically (stale tabs) — once only
  if (globalThis.__lecternBridge) return;
  globalThis.__lecternBridge = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // Liveness probe from the service worker: answering it explicitly is what
    // tells ensureContentScripts() the bridge is already here.
    if (msg && msg.__lecternPing) {
      sendResponse(true);
      return;
    }
    if (msg && msg.__lecternDown) {
      window.postMessage({ __lectern: 'down', msg: msg.payload }, '*');
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__lectern !== 'up') return;
    // Defense-in-depth shape check; the service worker is the real trust
    // boundary (it validates the payload and gates session creation on a user
    // gesture), this just drops obvious junk before it crosses worlds.
    const payload = e.data.msg;
    if (!payload || typeof payload !== 'object' || typeof payload.type !== 'string') return;
    try {
      chrome.runtime.sendMessage({ __lecternUp: true, payload }).catch(() => {});
    } catch {
      // extension was reloaded/uninstalled under this page — nothing to do
    }
  });
})();
