// Generates Lectern logo concepts with Google Imagen 4 Ultra:
//   node scripts/generate-logo.mjs            → all concepts, 2 variants each
//   node scripts/generate-logo.mjs mark 4     → one concept, N variants
// Needs GEMINI_API_KEY in .env (gitignored). Output: branding/*.png
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) {
  console.error('GEMINI_API_KEY missing from .env');
  process.exit(1);
}

// Default: gemini-3-pro-image (Nano Banana Pro) — works on standard API keys.
// The imagen-4.0 family (incl. -ultra) needs paid Imagen quota; this key 429s
// on it. Override when available: IMAGEN_MODEL=imagen-4.0-ultra-generate-001
const MODEL = process.env.IMAGEN_MODEL ?? 'gemini-3-pro-image';
const isImagen = MODEL.startsWith('imagen');

const SHARED =
  'Flat vector style, geometric construction, balanced negative space, crisp clean edges, ' +
  'flat solid color only, no gradients, no shadows, no 3D, no photorealism, generous empty margin, ' +
  'timeless premium identity-studio quality, warm editorial mood. ' +
  'Palette strictly: warm cream paper background #F4EEE1, deep warm ink #211D16, vermilion accent #C8401F.';

const PROMPTS = {
  mark:
    'Minimalist logo mark for "Lectern", a literary listening app, centered on a plain warm cream background. ' +
    'The mark: an abstract open book resting on a slender lectern reading-stand, drawn in deep warm ink; ' +
    'the text lines on the open pages lift upward and become a rising sound waveform of four rounded vertical ' +
    'bars in vermilion. ' +
    SHARED +
    ' Absolutely no letters, numbers, words or typography anywhere in the image.',
  monogram:
    'Minimalist monogram logo for "Lectern", a literary listening app, centered on a plain warm cream background. ' +
    'A single bold capital letter L in deep warm ink, where the vertical stem reads as a slender lectern ' +
    'reading-stand column, and the horizontal foot of the L transforms into four rounded sound-wave bars ' +
    'stepping upward in vermilion. ' +
    SHARED +
    ' No other letters, numbers or words besides the single L form.',
  lockup:
    'Premium logo lockup for a literary listening app, centered on a plain warm cream background. ' +
    'Above: a small minimalist mark of an open book on a slender lectern stand in deep warm ink with four ' +
    'rounded vermilion sound-wave bars rising from its pages. ' +
    'Below: the word "Lectern" set large in an elegant high-contrast italic serif typeface in deep warm ink, ' +
    'with a small vermilion period after the word. ' +
    SHARED,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callImagen(prompt, sampleCount) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:predict`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount, aspectRatio: '1:1', personGeneration: 'dont_allow' },
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  const images = (body.predictions ?? [])
    .map((p) => p.bytesBase64Encoded && { bytes: Buffer.from(p.bytesBase64Encoded, 'base64'), ext: 'png' })
    .filter(Boolean);
  if (!images.length) throw new Error(`No image in response: ${JSON.stringify(body).slice(0, 200)}`);
  return images;
}

async function callGeminiImage(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '1:1' } },
      }),
    },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  const part = (body.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData);
  if (!part) throw new Error(`No image in response: ${JSON.stringify(body).slice(0, 160)}`);
  return [
    {
      bytes: Buffer.from(part.inlineData.data, 'base64'),
      ext: part.inlineData.mimeType === 'image/png' ? 'png' : 'jpg',
    },
  ];
}

async function generate(prompt, sampleCount) {
  for (let attempt = 1; ; attempt++) {
    try {
      if (isImagen) return await callImagen(prompt, sampleCount);
      const images = [];
      for (let i = 0; i < sampleCount; i++) images.push(...(await callGeminiImage(prompt)));
      return images;
    } catch (err) {
      if (attempt >= 3) throw err;
      const wait = attempt * 25_000;
      console.log(`\n   ${err.message} — retrying in ${wait / 1000}s (${attempt}/2)`);
      await sleep(wait);
    }
  }
}

const [, , only, countArg] = process.argv;
const variants = Number(countArg ?? 2);
const concepts = only ? { [only]: PROMPTS[only] } : PROMPTS;
if (only && !PROMPTS[only]) {
  console.error(`Unknown concept "${only}" — use one of: ${Object.keys(PROMPTS).join(', ')}`);
  process.exit(1);
}

mkdirSync(path.join(root, 'branding'), { recursive: true });
console.log(`model: ${MODEL}`);
for (const [name, prompt] of Object.entries(concepts)) {
  process.stdout.write(`generating ${variants}× ${name}… `);
  try {
    const images = await generate(prompt, variants);
    images.forEach(({ bytes, ext }, i) => {
      writeFileSync(path.join(root, 'branding', `lectern-${name}-${i + 1}.${ext}`), bytes);
    });
    console.log(`→ branding/lectern-${name}-{1..${images.length}}`);
  } catch (err) {
    console.log(`failed: ${err.message}`);
  }
  await sleep(5000);
}
