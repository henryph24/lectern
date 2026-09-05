try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  // no .env — integration tests that need keys will skip themselves
}
