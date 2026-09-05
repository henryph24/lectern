import { mkdir, readFile, writeFile, rename, readdir, unlink, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const SAFE_ID = /^[a-z0-9-]+$/;
const DEFAULT_POSITION = { chunkIdx: 0, inChunkMs: 0 };

// Layout under dataDir:
//   docs/<id>.json       full document (blocks/sentences/chunks; chunk text is
//                        NOT stored — it is re-sliced from blocks on read)
//   meta/<id>.json       small summary used by the library list
//   positions/<id>.json  tiny resume position, rewritten on autosave
export function createStore(dataDir) {
  const docsDir = path.join(dataDir, 'docs');
  const metaDir = path.join(dataDir, 'meta');
  const posDir = path.join(dataDir, 'positions');
  const ready = Promise.all([
    mkdir(docsDir, { recursive: true }),
    mkdir(metaDir, { recursive: true }),
    mkdir(posDir, { recursive: true }),
  ]);

  const docFile = (id) => path.join(docsDir, `${id}.json`);
  const metaFile = (id) => path.join(metaDir, `${id}.json`);
  const posFile = (id) => path.join(posDir, `${id}.json`);

  async function writeJsonAtomic(file, value) {
    await writeFile(`${file}.tmp`, JSON.stringify(value));
    await rename(`${file}.tmp`, file);
  }

  async function readJson(file) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function summarize(doc) {
    return {
      id: doc.id,
      title: doc.title,
      source: doc.source,
      savedAt: doc.savedAt,
      chunkCount: doc.chunks.length,
      sentenceCount: doc.sentences.length,
      charCount: doc.blocks.reduce((n, b) => n + b.text.length, 0),
    };
  }

  function hydrate(doc, position) {
    return {
      ...doc,
      chunks: doc.chunks.map((c) => ({
        ...c,
        text: doc.blocks[c.block].text.slice(c.start, c.end),
      })),
      position: position ?? doc.position ?? DEFAULT_POSITION,
    };
  }

  async function readDocRaw(id) {
    if (!SAFE_ID.test(id)) return null;
    return readJson(docFile(id));
  }

  // legacy docs (pre-sidecar) carry chunk text and an embedded position;
  // first contact migrates them to meta/position sidecars
  async function healLegacy(id, doc) {
    const meta = summarize(doc);
    await writeJsonAtomic(metaFile(id), meta);
    if (doc.position && (doc.position.chunkIdx || doc.position.inChunkMs)) {
      const existing = await readJson(posFile(id));
      if (!existing) {
        await writeJsonAtomic(posFile(id), { ...doc.position, updatedAt: doc.updatedAt ?? doc.savedAt });
      }
    }
    return meta;
  }

  return {
    async create({ title, byline, siteName, source, blocks, sentences, chunks }) {
      await ready;
      const id = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      const doc = {
        id,
        title,
        ...(byline ? { byline } : {}),
        ...(siteName ? { siteName } : {}),
        source,
        savedAt: new Date().toISOString(),
        blocks,
        sentences,
        chunks: chunks.map(({ text, ...rest }) => rest),
      };
      await writeJsonAtomic(docFile(id), doc);
      await writeJsonAtomic(metaFile(id), summarize(doc));
      return hydrate(doc, DEFAULT_POSITION);
    },

    async list() {
      await ready;
      const ids = (await readdir(docsDir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
      const entries = await Promise.all(
        ids.map(async (id) => {
          if (!SAFE_ID.test(id)) return null;
          let meta = await readJson(metaFile(id));
          if (!meta) {
            const doc = await readDocRaw(id);
            if (!doc) return null;
            meta = await healLegacy(id, doc);
          }
          const pos = await readJson(posFile(id));
          return {
            ...meta,
            position: pos
              ? { chunkIdx: pos.chunkIdx, inChunkMs: pos.inChunkMs }
              : DEFAULT_POSITION,
            updatedAt: pos?.updatedAt ?? meta.savedAt,
          };
        }),
      );
      return entries.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async get(id) {
      await ready;
      const doc = await readDocRaw(id);
      if (!doc) return null;
      const pos = await readJson(posFile(id));
      return hydrate(doc, pos ? { chunkIdx: pos.chunkIdx, inChunkMs: pos.inChunkMs } : null);
    },

    async setPosition(id, position) {
      await ready;
      if (!SAFE_ID.test(id)) return false;
      try {
        await access(docFile(id));
      } catch {
        return false;
      }
      await writeJsonAtomic(posFile(id), { ...position, updatedAt: new Date().toISOString() });
      return true;
    },

    async remove(id) {
      await ready;
      if (!SAFE_ID.test(id)) return false;
      try {
        await unlink(docFile(id));
      } catch {
        return false;
      }
      await Promise.allSettled([unlink(metaFile(id)), unlink(posFile(id))]);
      return true;
    },
  };
}
