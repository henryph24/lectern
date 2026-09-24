import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spansToWords } from '../lib/words.js';
import { pcmFloatToMp3 } from '../lib/mp3.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_VOICE = 'af_heart';
const SAMPLE_RATE = 24_000; // the model's fixed output rate
const FRAME_SAMPLES = 600; // one `durations` frame: 24 kHz / 40 frames per second
const STYLE_DIM = 256;
// The 512-position context minus the pad token at each end. Longer text is
// synthesized in pieces and concatenated.
const MAX_TOKENS = 510;
const SPEED = 1; // neutral: Lectern's player owns the 0.5–3× rate control
const SILENCE_MS = 300; // what a chunk with nothing to voice plays

// Nine upstream English voices, the best by the hexgrad/Kokoro-82M VOICES.md
// grades (af_heart A, af_bella A-, af_nicole and bf_emma B-, the rest C+ or C).
// scripts/fetch-kokoro.mjs pins one voices/<id>.bin per id.
const VOICE_META = {
  af_heart: { name: 'Heart', gender: 'Female', locale: 'en-US' },
  af_bella: { name: 'Bella', gender: 'Female', locale: 'en-US' },
  af_nicole: { name: 'Nicole', gender: 'Female', locale: 'en-US' },
  am_fenrir: { name: 'Fenrir', gender: 'Male', locale: 'en-US' },
  am_michael: { name: 'Michael', gender: 'Male', locale: 'en-US' },
  am_puck: { name: 'Puck', gender: 'Male', locale: 'en-US' },
  bf_emma: { name: 'Emma', gender: 'Female', locale: 'en-GB' },
  bm_george: { name: 'George', gender: 'Male', locale: 'en-GB' },
  bm_fable: { name: 'Fable', gender: 'Male', locale: 'en-GB' },
};

// KOKORO_DIR overrides; default is the repo's data/ (matches `npm start` and
// dev desktop), exactly like SUPERTONIC_DIR.
function baseDir() {
  return process.env.KOKORO_DIR || path.join(__dirname, '..', '..', 'data', 'kokoro');
}
const modelPath = () => path.join(baseDir(), 'onnx', 'model.onnx');
const tokenizerPath = () => path.join(baseDir(), 'tokenizer.json');
const dictionaryPath = () => path.join(baseDir(), 'dictionaries', 'en-us.txt');
const voicePath = (id) => path.join(baseDir(), 'voices', `${id}.bin`);

// On-device: available only once `npm run fetch:kokoro` has put the model, its
// vocabulary, the pronouncing dictionary and at least one voice on disk.
export function available() {
  if (![modelPath(), tokenizerPath(), dictionaryPath()].every((p) => existsSync(p))) return false;
  return Object.keys(VOICE_META).some((id) => existsSync(voicePath(id)));
}

// The voice id is an allowlist against the closed preset set. This MUST gate
// any path built from the id (voices/<id>.bin): an unvalidated value like
// '../../../package' would be a path-traversal / file-existence oracle.
// hasOwnProperty keeps the check prototype-pollution safe; `id in` would also
// accept inherited keys such as 'constructor'.
export function isKnownVoice(id) {
  return Object.prototype.hasOwnProperty.call(VOICE_META, id);
}

export function voices() {
  if (!available()) return [];
  return Object.entries(VOICE_META)
    .filter(([id]) => existsSync(voicePath(id)))
    .map(([id, m]) => ({ id, label: `Kokoro ${m.name} (${m.locale})`, locale: m.locale, gender: m.gender }));
}

// A lazily started load, shared by concurrent callers. A failed load is
// forgotten so the next call retries: a half-fetched asset must not wedge the
// provider until the engine restarts.
function lazy(load) {
  let pending = null;
  const get = () =>
    (pending ??= load().catch((err) => {
      pending = null;
      throw err;
    }));
  get.reset = () => {
    pending = null;
  };
  return get;
}

// onnxruntime-node is a native addon and the model is 325 MB, so both load on
// first use: the engine must boot fine on machines without the assets.
const model = lazy(async () => {
  const ort = await import('onnxruntime-node');
  return { ort, session: await ort.InferenceSession.create(modelPath()) };
});

const isDigits = (s) => s.length > 0 && [...s].every((c) => c >= '0' && c <= '9');

// The vendored number reader (convertNumberToWords) rebuilds a decimal from
// parseFloat(num).toString(). Below 1e-6 that prints in exponent form, and 309
// or more digits print as Infinity: neither has a '.', so its decimal branch
// calls itself until the stack overflows. The same round trip reads
// "0.00000015" as "one point five undefined undefined seven", drops written
// digits ("1.10" as "one point one") and changes digits past 2^53. This
// subclass reads written numbers digit for digit as written and leaves every
// other number to the vendored reader.
function withWrittenNumbers(Language) {
  return class extends Language {
    convertNumberToWords(num, isNotSpecial = false) {
      // The vendored code passes doubles to itself. Only a non-finite one can
      // loop (an ordinal of 309+ digits), and its digits are already lost.
      if (typeof num !== 'string') return Number.isFinite(num) ? super.convertNumberToWords(num, isNotSpecial) : '';
      if (num.startsWith('-')) return `MINUS ${this.convertNumberToWords(num.slice(1), isNotSpecial).trim()}`;
      const point = num.indexOf('.');
      if (point > 0) {
        const whole = this.convertNumberToWords(num.slice(0, point), isNotSpecial).trim();
        return `${whole} POINT ${this.convertDigitByDigit(num.slice(point + 1)).trim()}`;
      }
      if (isDigits(num) && !Number.isSafeInteger(Number(num))) return this.convertDigitByDigit(num);
      return super.convertNumberToWords(num, isNotSpecial);
    }
  };
}

const g2p = lazy(async () => {
  const { Language } = await import('./kokoro/language-en-us.mjs');
  const language = new (withWrittenNumbers(Language))();
  await language.loadDictionary(dictionaryPath());
  return language;
});

// Phoneme symbol → token id, from the pinned tokenizer.json.
const vocab = lazy(async () => {
  const { model: tokenizer } = JSON.parse(await readFile(tokenizerPath(), 'utf8'));
  return new Map(Object.entries(tokenizer.vocab));
});

// voices/<id>.bin is a float32 [rows x 256] style table; row n styles an
// utterance of n tokens.
const voiceTables = new Map();
function voiceTable(id) {
  if (!voiceTables.has(id)) {
    const table = readFile(voicePath(id)).then((buf) => {
      if (!buf.byteLength || buf.byteLength % (STYLE_DIM * 4)) throw new Error('Kokoro voice file is malformed');
      return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    });
    table.catch(() => voiceTables.delete(id));
    voiceTables.set(id, table);
  }
  return voiceTables.get(id);
}

function unknownVoice() {
  // Generic message: never echo the (possibly malicious) id back.
  return Object.assign(new Error('Unknown Kokoro voice'), { status: 400 });
}

// The G2P drops every character it has no rule for, typographic apostrophes
// included: "we’re" would be read as "were" and "I’ll" as "ill". The en dash
// is dropped too, while the em dash is voiced as a pause. Each swap replaces
// one UTF-16 unit with one, so G2P offsets stay valid in the original text.
const G2P_SWAPS = new Map([
  ['\u2018', "'"], // left single quotation mark
  ['\u2019', "'"], // right single quotation mark, the usual web apostrophe
  ['\u02BC', "'"], // modifier letter apostrophe
  ['\u2013', '\u2014'], // en dash → em dash
]);
function forG2p(text) {
  let out = '';
  for (const ch of text) out += G2P_SWAPS.get(ch) ?? ch;
  return out;
}

// Punctuation and spaces are real tokens (the model voices them as pauses),
// but a word's highlight should cover only its phonemes.
const PAUSES = new Set([...';:,.!?—…"()“” ']);

// Phonemizes `text` into token ids, plus one entry per G2P part (a
// whitespace-delimited token and its trailing whitespace; the parts tile the
// text end to end): its char range, its token range [from, to), and the token
// range of its speech [speechFrom, speechTo), the part minus edge pauses.
function tokenize(language, symbols, text) {
  const { phonemes, metadata } = language.generate(forG2p(text));
  const ids = [];
  const isSpeech = [];
  const firstToken = []; // phoneme index → index of its first token
  for (const phoneme of phonemes) {
    firstToken.push(ids.length);
    for (const symbol of phoneme) {
      const id = symbols.get(symbol);
      if (id === undefined) continue; // outside the vocabulary: the tokenizer drops it too
      ids.push(id);
      isSpeech.push(!PAUSES.has(symbol));
    }
  }
  firstToken.push(ids.length);

  const parts = [];
  let charStart = 0;
  metadata.words.forEach((partText, i) => {
    const from = firstToken[metadata.wtimes[i]];
    const to = firstToken[metadata.wdurations[i]];
    let speechFrom = from;
    let speechTo = to;
    while (speechFrom < speechTo && !isSpeech[speechFrom]) speechFrom++;
    while (speechTo > speechFrom && !isSpeech[speechTo - 1]) speechTo--;
    parts.push({ charStart, charEnd: charStart + partText.length, from, to, speechFrom, speechTo });
    charStart += partText.length;
  });
  return { ids, parts, hasSpeech: isSpeech.includes(true) };
}

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

// Cuts tokens [0, total) into ranges of at most MAX_TOKENS. A cut lands on a
// part boundary (a word boundary), at the last sentence end that fits when
// there is one; only a single part longer than the context is cut inside.
function planPieces(text, parts, total) {
  if (total <= MAX_TOKENS) return [[0, total]];
  const sentenceEnds = new Set(Array.from(sentenceSegmenter.segment(text), (s) => s.index + s.segment.length));
  const pieces = [];
  let from = 0;
  while (total - from > MAX_TOKENS) {
    const limit = from + MAX_TOKENS;
    let wordCut = 0;
    let sentenceCut = 0;
    for (const part of parts) {
      if (part.to <= from) continue;
      if (part.to > limit) break;
      wordCut = part.to;
      if (sentenceEnds.has(part.charEnd)) sentenceCut = part.to;
    }
    const cut = sentenceCut || wordCut || limit;
    pieces.push([from, cut]);
    from = cut;
  }
  pieces.push([from, total]);
  return pieces;
}

async function infer({ ort, session }, ids, table) {
  const row = Math.min(ids.length, table.length / STYLE_DIM - 1);
  const out = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from([0, ...ids, 0], (n) => BigInt(n)), [1, ids.length + 2]),
    style: new ort.Tensor('float32', table.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM), [1, STYLE_DIM]),
    speed: new ort.Tensor('float32', Float32Array.of(SPEED), [1]),
  });
  const durations = Array.from(out.durations.data, Number);
  // One duration per input token, pads included: anything else would turn
  // every word timing into NaN, so fail the chunk loudly.
  if (durations.length !== ids.length + 2) {
    throw new Error(`Kokoro returned ${durations.length} durations for ${ids.length + 2} tokens`);
  }
  return { waveform: out.waveform.data, durations };
}

// ONNX Round, like torch.round, sends halves to the even neighbour.
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

// Millisecond edges of one call's tokens: edges[k] starts model token k (the
// leading pad is token 0). The decoder gives token k max(1, round(d_k)) frames
// of 600 samples, while `durations` reports d_k from before that rounding.
// When the rounded frames account for the waveform exactly, use them for
// sample-exact word edges; otherwise stretch the float durations onto the
// real audio length.
function tokenEdges(durations, samples) {
  const rounded = durations.map((d) => Math.max(1, roundHalfEven(d)));
  const frames = sum(rounded) * FRAME_SAMPLES === samples ? rounded : durations;
  const total = sum(frames);
  const msPerFrame = total > 0 ? (samples * 1000) / SAMPLE_RATE / total : 0;
  const edges = [0];
  let acc = 0;
  for (const f of frames) edges.push((acc += f) * msPerFrame);
  return edges;
}

function concat(chunks, length) {
  if (chunks.length === 1) return chunks[0];
  const out = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export async function synthesize({ text, voice = DEFAULT_VOICE }) {
  if (!isKnownVoice(voice) || !existsSync(voicePath(voice))) throw unknownVoice();
  const [language, symbols, table] = await Promise.all([g2p(), vocab(), voiceTable(voice)]);
  const { ids, parts, hasSpeech } = tokenize(language, symbols, text);
  // Nothing to speak: text the G2P cannot voice (non-Latin script, emoji)
  // leaves no token, and punctuation alone leaves only pauses, which the model
  // fills with a burst of noise. Play a beat of silence so playback moves on.
  if (!hasSpeech) {
    const silence = new Float32Array((SAMPLE_RATE * SILENCE_MS) / 1000);
    return { audio: pcmFloatToMp3(silence, SAMPLE_RATE), format: 'mp3', words: [] };
  }

  const loaded = await model();
  const space = symbols.get(' ');
  const starts = new Float64Array(ids.length);
  const ends = new Float64Array(ids.length);
  const waves = [];
  let samples = 0;
  for (const [from, to] of planPieces(text, parts, ids.length)) {
    // Utterances neither start nor end on a space: those tokens stay out of
    // the model input and sit, zero-length, at the piece edge.
    let a = from;
    let b = to;
    while (a < b && ids[a] === space) a++;
    while (b > a && ids[b - 1] === space) b--;
    const startMs = (samples * 1000) / SAMPLE_RATE;
    let edges = null;
    if (a < b) {
      const { waveform, durations } = await infer(loaded, ids.slice(a, b), table);
      edges = tokenEdges(durations, waveform.length);
      waves.push(waveform);
      samples += waveform.length;
    }
    const endMs = (samples * 1000) / SAMPLE_RATE;
    for (let k = from; k < to; k++) {
      if (k < a) starts[k] = ends[k] = startMs;
      else if (k >= b) starts[k] = ends[k] = endMs;
      else {
        starts[k] = startMs + edges[k - a + 1];
        ends[k] = startMs + edges[k - a + 2];
      }
    }
  }

  const spans = parts.map((p) => {
    const spoken = p.speechFrom < p.speechTo;
    return {
      charStart: p.charStart,
      charEnd: p.charEnd,
      startMs: spoken ? starts[p.speechFrom] : null,
      endMs: spoken ? ends[p.speechTo - 1] : null,
    };
  });
  return {
    audio: pcmFloatToMp3(concat(waves, samples), SAMPLE_RATE),
    format: 'mp3',
    words: spansToWords(text, spans),
  };
}

export function resetForTests() {
  model.reset();
  g2p.reset();
  vocab.reset();
  voiceTables.clear();
}
