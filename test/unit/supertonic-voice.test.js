import { describe, it, expect } from 'vitest';
import { isKnownVoice } from '../../server/providers/supertonic.js';

// The voice id gates voiceStylePath(`${id}.json`); an unvalidated id would be a
// path-traversal / file-existence oracle, so only the closed preset set passes.
describe('supertonic isKnownVoice (path-traversal allowlist)', () => {
  it('accepts the preset voice ids', () => {
    for (const id of ['M1', 'M5', 'F1', 'F5']) expect(isKnownVoice(id)).toBe(true);
  });

  it('rejects traversal payloads, prototype keys, and unknown ids', () => {
    for (const id of ['../../../package', '../../etc/passwd', '__proto__', 'constructor', 'toString', 'M6', '']) {
      expect(isKnownVoice(id), id).toBe(false);
    }
  });
});
