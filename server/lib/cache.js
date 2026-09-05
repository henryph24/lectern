import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

export function cacheKey(provider, voice, text) {
  return createHash('sha256').update(JSON.stringify([provider, voice, text])).digest('hex');
}

export function createCache(dir) {
  const ready = mkdir(dir, { recursive: true });
  const audioPath = (key) => path.join(dir, `${key}.mp3`);
  const metaPath = (key) => path.join(dir, `${key}.json`);

  return {
    async get(key) {
      try {
        await ready;
        const [audio, meta] = await Promise.all([
          readFile(audioPath(key)),
          readFile(metaPath(key), 'utf8'),
        ]);
        const { format, words } = JSON.parse(meta);
        return { audio, format, words };
      } catch {
        return null;
      }
    },

    async put(key, { audio, format, words }) {
      await ready;
      await writeFile(`${audioPath(key)}.tmp`, audio);
      await writeFile(`${metaPath(key)}.tmp`, JSON.stringify({ format, words }));
      await rename(`${audioPath(key)}.tmp`, audioPath(key));
      await rename(`${metaPath(key)}.tmp`, metaPath(key));
    },
  };
}
