import { Communicate, listVoices } from 'edge-tts-universal';
import { edgeBoundariesToWords } from '../lib/words.js';

export const DEFAULT_VOICE = 'en-US-AvaMultilingualNeural';

export const CURATED_VOICE_IDS = [
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-BrianMultilingualNeural',
  'en-US-AriaNeural',
  'en-US-JennyNeural',
  'en-US-GuyNeural',
  'en-US-ChristopherNeural',
  'en-GB-SoniaNeural',
  'en-GB-RyanNeural',
];

// The voice id is interpolated into the SSML the upstream library builds, and
// that interpolation does not escape quotes: an id like
// `en-US-x'/><break time='10s'/><voice name='en-US-AvaMultilingualNeural`
// passes the library's own shape check and injects SSML elements into the
// request. So the id must be one Microsoft actually publishes, never an
// arbitrary string. The list is cached for 24 h, so this costs nothing per chunk.
export async function isKnownVoice(id) {
  if (typeof id !== 'string') return false;
  const all = await voices({ all: true });
  return all.some((v) => v.id === id);
}

export async function synthesize({ text, voice = DEFAULT_VOICE }) {
  const communicate = new Communicate(text, { voice, connectionTimeout: 15_000 });
  const buffers = [];
  const boundaries = [];
  for await (const chunk of communicate.stream()) {
    if (chunk.type === 'audio' && chunk.data) {
      buffers.push(chunk.data);
    } else if (chunk.type === 'WordBoundary') {
      boundaries.push({
        text: chunk.text,
        // offset/duration are 100-nanosecond ticks
        startMs: Math.round(chunk.offset / 10_000),
        endMs: Math.round((chunk.offset + chunk.duration) / 10_000),
      });
    }
  }
  if (buffers.length === 0) throw new Error('Edge TTS returned no audio');
  return {
    audio: Buffer.concat(buffers),
    format: 'mp3',
    words: edgeBoundariesToWords(boundaries, text),
  };
}

let voicesCache = null;
const VOICES_TTL_MS = 24 * 60 * 60 * 1000;

export async function voices({ all = false } = {}) {
  if (!voicesCache || Date.now() - voicesCache.at > VOICES_TTL_MS) {
    const raw = await listVoices();
    voicesCache = {
      at: Date.now(),
      list: raw.map((v) => ({
        id: v.ShortName,
        label: labelFor(v.ShortName, v.Locale),
        locale: v.Locale,
        gender: v.Gender,
      })),
    };
  }
  if (all) return voicesCache.list;
  const byId = new Map(voicesCache.list.map((v) => [v.id, v]));
  return CURATED_VOICE_IDS.map((id) => byId.get(id)).filter(Boolean);
}

function labelFor(shortName, locale) {
  let name = shortName.split('-').pop() ?? shortName;
  for (const suffix of ['MultilingualNeural', 'Neural']) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length);
      break;
    }
  }
  return locale ? `${name} (${locale})` : name;
}
