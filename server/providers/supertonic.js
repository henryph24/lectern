import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { durationToWords } from '../lib/words.js';
import { pcmFloatToMp3 } from '../lib/mp3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_VOICE = 'M1';
const DEFAULT_STEPS = 8; // denoising steps (upstream Node default); higher = better/slower
const SPEED = 1.0; // neutral — Lectern's player owns the 0.5–3× rate control
const LANG = 'en'; // voice ids don't bind a language; default to English for v1

// Supertonic ships preset speaker styles M1–M5 / F1–F5 as JSON tensors.
const VOICE_META = {
  M1: { label: 'Male 1', gender: 'Male' },
  M2: { label: 'Male 2', gender: 'Male' },
  M3: { label: 'Male 3', gender: 'Male' },
  M4: { label: 'Male 4', gender: 'Male' },
  M5: { label: 'Male 5', gender: 'Male' },
  F1: { label: 'Female 1', gender: 'Female' },
  F2: { label: 'Female 2', gender: 'Female' },
  F3: { label: 'Female 3', gender: 'Female' },
  F4: { label: 'Female 4', gender: 'Female' },
  F5: { label: 'Female 5', gender: 'Female' },
};

// Files loadTextToSpeech() needs under <dir>/onnx (see vendored helper.js).
const REQUIRED_ONNX = [
  'duration_predictor.onnx',
  'text_encoder.onnx',
  'vector_estimator.onnx',
  'vocoder.onnx',
  'tts.json',
  'unicode_indexer.json',
];

// SUPERTONIC_DIR overrides; default is the repo's data/ (matches `npm start` and
// dev desktop). Packaged desktop should set SUPERTONIC_DIR to its userData path.
function baseDir() {
  return process.env.SUPERTONIC_DIR || path.join(__dirname, '..', '..', 'data', 'supertonic');
}
const onnxDir = () => path.join(baseDir(), 'onnx');
const voiceStylePath = (id) => path.join(baseDir(), 'voice_styles', `${id}.json`);

// On-device: available only once the ~398 MB ONNX assets have been fetched to disk
// (npm run fetch:supertonic), mirroring how ElevenLabs gates on an API key.
export function available() {
  const dir = onnxDir();
  if (!REQUIRED_ONNX.every((f) => existsSync(path.join(dir, f)))) return false;
  return Object.keys(VOICE_META).some((id) => existsSync(voiceStylePath(id)));
}

// The vendored helper imports onnxruntime-node at module top, so defer loading it
// until first use — the engine must boot fine on machines without the assets/dep.
let helperPromise = null;
const helper = () => (helperPromise ??= import('./supertonic/helper.js'));

let ttsPromise = null;
async function getTts() {
  if (!ttsPromise) ttsPromise = helper().then((h) => h.loadTextToSpeech(onnxDir()));
  return ttsPromise;
}

// The voice id is an allowlist against the closed preset set. This MUST gate
// any path built from the id (voiceStylePath(`${id}.json`)) — an unvalidated
// value like '../../../package' would be a path-traversal / file-existence
// oracle. hasOwnProperty (not `id in`) keeps the check prototype-pollution safe.
export function isKnownVoice(id) {
  return Object.prototype.hasOwnProperty.call(VOICE_META, id);
}

const styleCache = new Map();
async function getStyle(id) {
  if (!isKnownVoice(id)) {
    // Generic message — never echo the (possibly malicious) id back.
    throw Object.assign(new Error('Unknown Supertonic voice'), { status: 400 });
  }
  if (!styleCache.has(id)) {
    if (!existsSync(voiceStylePath(id))) {
      throw Object.assign(new Error('Unknown Supertonic voice'), { status: 400 });
    }
    const h = await helper();
    styleCache.set(id, h.loadVoiceStyle([voiceStylePath(id)]));
  }
  return styleCache.get(id);
}

export async function synthesize({ text, voice = DEFAULT_VOICE }) {
  const [tts, style] = await Promise.all([getTts(), getStyle(voice)]);
  const { wav, duration } = await tts.call(text, LANG, style, DEFAULT_STEPS, SPEED);
  if (!wav || wav.length === 0) throw new Error('Supertonic produced no audio');
  return {
    audio: pcmFloatToMp3(wav instanceof Float32Array ? wav : Float32Array.from(wav), tts.sampleRate),
    format: 'mp3',
    words: durationToWords(text, duration[0]),
  };
}

export function voices() {
  if (!available()) return [];
  return Object.entries(VOICE_META)
    .filter(([id]) => existsSync(voiceStylePath(id)))
    .map(([id, m]) => ({ id, label: `Supertonic ${m.label}`, locale: 'multi', gender: m.gender }));
}

export function resetForTests() {
  helperPromise = null;
  ttsPromise = null;
  styleCache.clear();
}
