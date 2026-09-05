import { elevenAlignmentToWords } from '../lib/words.js';

export const DEFAULT_MODEL = 'eleven_flash_v2_5';

let client = null;

export function available() {
  return Boolean(process.env.ELEVENLABS_API_KEY);
}

async function getClient() {
  if (!client) {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js');
    client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
  }
  return client;
}

export async function synthesize({ text, voice }) {
  const c = await getClient();
  const res = await c.textToSpeech.convertWithTimestamps(voice, {
    text,
    modelId: DEFAULT_MODEL,
    outputFormat: 'mp3_44100_128',
  });
  return {
    audio: Buffer.from(res.audioBase64, 'base64'),
    format: 'mp3',
    words: res.alignment ? elevenAlignmentToWords(res.alignment) : [],
  };
}

// Cached like the edge list: /api/voices is reachable by any local process and
// by an Origin-less cross-site GET, and every uncached call spends the user's
// ElevenLabs quota.
let voicesCache = null;
const VOICES_TTL_MS = 5 * 60 * 1000;

export async function isKnownVoice(id) {
  if (typeof id !== 'string') return false;
  return (await voices()).some((v) => v.id === id);
}

export async function voices() {
  if (!available()) return [];
  if (voicesCache && Date.now() - voicesCache.at < VOICES_TTL_MS) return voicesCache.list;
  const c = await getClient();
  const res = await c.voices.search();
  const list = (res.voices ?? []).map((v) => ({
    id: v.voiceId,
    label: v.name ?? v.voiceId,
    locale: v.labels?.language ?? '',
    gender: v.labels?.gender ?? '',
  }));
  voicesCache = { at: Date.now(), list };
  return list;
}

export function resetClientForTests() {
  client = null;
  voicesCache = null;
}
