import { describe, it, expect } from 'vitest';
import { isKnownVoice } from '../../server/providers/kokoro.js';

// The voice id builds voices/<id>.bin; an unvalidated id would be a
// path-traversal / file-existence oracle, so only the closed preset set passes.
describe('kokoro isKnownVoice (path-traversal allowlist)', () => {
  it('accepts the preset voice ids', () => {
    for (const id of ['af_heart', 'af_bella', 'af_nicole', 'am_fenrir', 'am_michael', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable']) {
      expect(isKnownVoice(id), id).toBe(true);
    }
  });

  it('rejects traversal payloads, prototype keys, unlisted upstream voices and unknown ids', () => {
    for (const id of [
      '../../../package',
      '../voices/af_heart',
      'af_heart/../../../etc/passwd',
      'af_heart.bin',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'af_sky', // an upstream voice that scripts/fetch-kokoro.mjs does not fetch
      'AF_HEART',
      '',
    ]) {
      expect(isKnownVoice(id), id).toBe(false);
    }
  });
});
