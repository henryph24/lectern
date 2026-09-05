#!/usr/bin/env node
// Downloads the Supertonic-3 ONNX assets + preset voice styles from Hugging Face
// into data/supertonic/ (or $SUPERTONIC_DIR). ~398 MB total; re-runs skip files
// that are already present AND checksum-clean. Pass --force to re-download all.
//
//   npm run fetch:supertonic
//
// These weights are parsed in-process by onnxruntime-node — a native protobuf
// reader — so the download is pinned and verified end to end:
//   * REV is an immutable commit sha. A branch name such as `main` can move
//     under us between the review of a model and the fetch of it, so it is
//     never used here;
//   * every byte is hashed while it streams, and the temp file is promoted to
//     its final name only after its sha256 matches SHA256 below. A mismatched,
//     truncated or interrupted transfer is unlinked, so a half-written file can
//     never be mistaken for a present one on the next run;
//   * files already on disk are re-hashed before being skipped, which also
//     re-validates anything an older, unchecksummed version of this script left
//     behind.
//
// Model weights are OpenRAIL-M licensed (see the repo); this only fetches them.
//
// ─── Bumping the model (how SHA256 below was generated) ──────────────────────
// 1. Read the new head commit sha and put it in REV:
//      curl -s https://huggingface.co/api/models/Supertone/supertonic-3 | jq -r .sha
// 2. The four large .onnx files are Git-LFS, and LFS pointers carry the sha256
//    as their oid — so the tree API hands them over without downloading 398 MB:
//      REV=<sha from step 1>
//      for d in onnx voice_styles; do
//        curl -s "https://huggingface.co/api/models/Supertone/supertonic-3/tree/$REV/$d?recursive=true"
//      done | jq -r '.[] | select(.lfs) | "\(.path) \(.lfs.oid)"'
// 3. The small JSON files are plain git blobs (no .lfs field, a few hundred KB
//    each) — fetch and hash them directly:
//      curl -sL "https://huggingface.co/Supertone/supertonic-3/resolve/$REV/<path>" | shasum -a 256
//    Cross-check each one against the tree API's git blob `oid` with
//    `git hash-object <file>` before trusting it.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = 'Supertone/supertonic-3';
// Immutable commit sha — verified as the head of `main` on 2026-09-05 via
// https://huggingface.co/api/models/Supertone/supertonic-3 (.sha).
const REV = '3cadd1ee6394adea1bd021217a0e650ede09a323';
const BASE = `https://huggingface.co/${REPO}/resolve/${REV}`;

const ONNX = ['duration_predictor.onnx', 'text_encoder.onnx', 'vector_estimator.onnx', 'vocoder.onnx', 'tts.json', 'unicode_indexer.json'];
const STYLES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'].map((v) => `${v}.json`);
const FILES = [...ONNX.map((f) => `onnx/${f}`), ...STYLES.map((f) => `voice_styles/${f}`)];

// sha256 of every file in FILES, at REV. Regenerate with the recipe above.
const SHA256 = {
  'onnx/duration_predictor.onnx': 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db',
  'onnx/text_encoder.onnx': 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff',
  'onnx/vector_estimator.onnx': '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c',
  'onnx/vocoder.onnx': '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba',
  'onnx/tts.json': '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09',
  'onnx/unicode_indexer.json': '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f',
  'voice_styles/M1.json': 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b',
  'voice_styles/M2.json': 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50',
  'voice_styles/M3.json': 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b',
  'voice_styles/M4.json': 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303',
  'voice_styles/M5.json': 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2',
  'voice_styles/F1.json': 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2',
  'voice_styles/F2.json': '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6',
  'voice_styles/F3.json': '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab',
  'voice_styles/F4.json': 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b',
  'voice_styles/F5.json': '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d',
};

// A file added to FILES without a pinned digest would download unverified.
// Fail the whole run at startup, before a single byte moves.
const unpinned = FILES.filter((rel) => !SHA256[rel]);
if (unpinned.length) throw new Error(`fetch-supertonic: no sha256 pinned for ${unpinned.join(', ')}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const destDir = process.env.SUPERTONIC_DIR || path.join(__dirname, '..', 'data', 'supertonic');
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
  const url = `${BASE}/${rel}?download=true`;
  const res = await fetch(url);
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
    console.log(`  ! ${rel} on disk does not match ${REV} — re-downloading`);
  }
  await download(rel, out, want);
}

console.log(`Fetching Supertonic-3 assets → ${destDir}`);
console.log(`  ${REPO} @ ${REV}`);
for (const rel of FILES) await ensure(rel);
console.log('\nAll assets ready and checksummed. Supertonic provider will activate on next engine start.');
