try {
  process.loadEnvFile();
} catch {
  // no .env file — fine, Edge TTS needs no configuration
}

const { createApp } = await import('./app.js');

const port = Number(process.env.PORT ?? 3000);
// Bind loopback IPv4 explicitly. The desktop app listens on 127.0.0.1, and its
// "reuse a running engine" check relies on an EADDRINUSE collision. A default
// IPv6 "::" bind does NOT collide with the desktop's 127.0.0.1 bind, so the app
// would start a SECOND (stale) engine on 127.0.0.1:3000 instead of reusing this
// one. Binding 127.0.0.1 here makes them collide → the desktop reuses this engine.
const host = process.env.HOST ?? '127.0.0.1';
createApp().listen(port, host, () => {
  console.log(`Speechify clone listening → http://localhost:${port}`);
});
