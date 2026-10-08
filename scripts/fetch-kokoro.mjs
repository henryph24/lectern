#!/usr/bin/env node
// Downloads the Kokoro-82M v1.0 ONNX model, its tokenizer vocabulary, nine
// preset voices and the American-English pronouncing dictionary into
// data/kokoro/ (or $KOKORO_DIR). ~333 MB total; re-runs skip files that are
// already present AND checksum-clean. Pass --force to re-download all.
//
//   npm run fetch:kokoro
//
// These weights are parsed in-process by onnxruntime-node (a native protobuf
// reader) and the dictionary is read line by line by the G2P, so the download
// is pinned and verified end to end, exactly like fetch-supertonic.mjs:
//   * both sources are fetched at an immutable commit sha. A branch name such
//     as `main` can move under us between the review of a file and the fetch
//     of it, so it is never used here;
//   * every byte is hashed while it streams, and the temp file is promoted to
//     its final name only after its sha256 matches SHA256 below. A mismatched,
//     truncated or interrupted transfer is unlinked, so a half-written file can
//     never be mistaken for a present one on the next run;
//   * files already on disk are re-hashed before being skipped.
//
// Licenses: the model and voices are Apache-2.0 (hexgrad/Kokoro-82M, ONNX export
// by onnx-community). The dictionary is HeadTTS's Misaki-phoneme conversion of
// CMUdict (HeadTTS is MIT, CMUdict is BSD); its header carries the CMU notice.
// This script only fetches them; none of these files is committed.
//
// ─── Bumping a pin (how SHA256 below was generated) ─────────────────────────
// Model, tokenizer, voices (Hugging Face):
// 1. Read the new head commit sha and put it in HF_REV:
//      curl -s https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped | jq -r .sha
// 2. model.onnx and voices/*.bin are Git-LFS, and LFS pointers carry the sha256
//    as their oid, so the tree API hands them over without downloading 333 MB:
//      curl -s "https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/tree/$HF_REV?recursive=true" \
//        | jq -r '.[] | select(.lfs) | "\(.path) \(.lfs.oid)"'
// 3. tokenizer.json is a plain git blob (no .lfs field, 3.5 KB): fetch and hash
//    it directly, then cross-check `git hash-object <file>` against the tree
//    API's git blob `oid` before trusting it:
//      curl -sL "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve/$HF_REV/tokenizer.json" | shasum -a 256
// Dictionary (HeadTTS):
// 4. G2P_REV is the `gitHead` npm recorded for the vendored release, which
//    pins the dictionary to the same code as server/providers/kokoro/:
//      curl -s https://registry.npmjs.org/@met4citizen/headtts/1.3.0 | jq -r .gitHead
// 5. Hash dictionaries/en-us.txt from BOTH the npm tarball (whose sha512 is the
//    registry's `dist.integrity`) and the GitHub raw URL at G2P_REV; pin it
//    only when the two digests agree.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HF_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
// Immutable commit sha, verified as the head of `main` on 2026-09-24 via
// https://huggingface.co/api/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped (.sha).
const HF_REV = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
const HF_BASE = `https://huggingface.co/${HF_REPO}/resolve/${HF_REV}`;

const G2P_REPO = 'met4citizen/HeadTTS';
// gitHead of @met4citizen/headtts@1.3.0 on npm, the release vendored in
// server/providers/kokoro/.
const G2P_REV = 'c08f4ca8b3253b3e908e501486a1e068e606be5c';
const G2P_BASE = `https://raw.githubusercontent.com/${G2P_REPO}/${G2P_REV}`;

// The English voices with the best upstream grades (hexgrad/Kokoro-82M
// VOICES.md). Keep in sync with VOICE_META in server/providers/kokoro.js.
const VOICES = ['af_heart', 'af_bella', 'af_nicole', 'am_fenrir', 'am_michael', 'am_puck', 'bf_emma', 'bm_george', 'bm_fable'];

// Destination path (relative to the kokoro dir) → source URL.
const SOURCES = {
  'onnx/model.onnx': `${HF_BASE}/onnx/model.onnx`,
  'tokenizer.json': `${HF_BASE}/tokenizer.json`,
  ...Object.fromEntries(VOICES.map((v) => [`voices/${v}.bin`, `${HF_BASE}/voices/${v}.bin`])),
  'dictionaries/en-us.txt': `${G2P_BASE}/dictionaries/en-us.txt`,
};
const FILES = Object.keys(SOURCES);

// sha256 of every file in FILES, at its pinned rev. Regenerate with the recipe above.
const SHA256 = {
  'onnx/model.onnx': '651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'voices/af_heart.bin': 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  'voices/af_bella.bin': 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  'voices/af_nicole.bin': 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  'voices/am_fenrir.bin': 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  'voices/am_michael.bin': '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  'voices/am_puck.bin': 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0',
  'voices/bf_emma.bin': '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  'voices/bm_george.bin': 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  'voices/bm_fable.bin': 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
  'dictionaries/en-us.txt': '5edf7f0e8e8c49fdf5fa1d27481980d9a83edf2c9a89de5898a1a88eb215cd2e',
};

// A file added to FILES without a pinned digest would download unverified.
// Fail the whole run at startup, before a single byte moves.
const unpinned = FILES.filter((rel) => !SHA256[rel]);
if (unpinned.length) throw new Error(`fetch-kokoro: no sha256 pinned for ${unpinned.join(', ')}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const destDir = process.env.KOKORO_DIR || path.join(__dirname, '..', 'data', 'kokoro');
const force = process.argv.includes('--force');

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

async function exists(p) {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function sha256File(p) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(p)) hash.update(chunk);
  return hash.digest('hex');
}

// Streams rel to <out>.tmp while hashing it, and renames into place ONLY after
// the digest matches. Any failure unlinks the tmp file, so the final path never
// holds unverified bytes.
async function download(rel, out, want) {
  const res = await fetch(SOURCES[rel]);
  if (!res.ok || !res.body) throw new Error(`${rel}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  process.stdout.write(`  ↓ ${rel}${total ? ` (${mb(total)})` : ''} … `);
  const tmp = `${out}.tmp`;
  const hash = createHash('sha256');
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      async function* (source) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    const got = hash.digest('hex');
    if (got !== want) throw new Error(`${rel}: sha256 mismatch\n    expected ${want}\n    got      ${got}`);
    await rename(tmp, out);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    console.log('FAILED');
    throw err;
  }
  console.log('done (sha256 verified)');
}

async function ensure(rel) {
  const out = path.join(destDir, rel);
  const want = SHA256[rel];
  await mkdir(path.dirname(out), { recursive: true });
  if (!force && (await exists(out))) {
    if ((await sha256File(out)) === want) {
      console.log(`  ✓ ${rel} (already present, sha256 verified)`);
      return;
    }
    console.log(`  ! ${rel} on disk does not match its pin, re-downloading`);
  }
  await download(rel, out, want);
}

console.log(`Fetching Kokoro-82M assets → ${destDir}`);
console.log(`  ${HF_REPO} @ ${HF_REV}`);
console.log(`  ${G2P_REPO} @ ${G2P_REV} (dictionary)`);
for (const rel of FILES) await ensure(rel);
console.log('\nAll assets ready and checksummed. The Kokoro provider will activate on next engine start.');
