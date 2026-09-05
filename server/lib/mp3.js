import * as lame from '@breezystack/lamejs';

// `@breezystack/lamejs` ships both a namespace and a default export depending on
// the resolver; normalize so `new Mp3Encoder()` works either way.
const Mp3Encoder = lame.Mp3Encoder ?? lame.default?.Mp3Encoder;

const BLOCK_SIZE = 1152; // one MPEG frame's worth of samples
const KBPS = 128;

// Encode mono Float32 PCM (samples in [-1, 1]) to an mp3 Buffer. Providers whose
// native output is WAV/PCM (e.g. Supertonic) use this so every provider can honor
// the uniform `format: 'mp3'` contract — clients and the disk cache assume mp3.
export function pcmFloatToMp3(samples, sampleRate) {
  if (!Mp3Encoder) throw new Error('lamejs Mp3Encoder unavailable');
  const encoder = new Mp3Encoder(1, sampleRate, KBPS);

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = Math.round(s * 32767);
  }

  const parts = [];
  for (let i = 0; i < pcm.length; i += BLOCK_SIZE) {
    const buf = encoder.encodeBuffer(pcm.subarray(i, i + BLOCK_SIZE));
    if (buf.length > 0) parts.push(Buffer.from(buf));
  }
  const tail = encoder.flush();
  if (tail.length > 0) parts.push(Buffer.from(tail));

  return Buffer.concat(parts);
}
