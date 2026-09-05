import { normalizeWhitespace } from './blocks.js';

export function textToBlocks(text, title) {
  const blocks = [];
  let current = [];
  const flush = () => {
    const t = normalizeWhitespace(current.join(' '));
    if (t) blocks.push({ type: 'p', text: t });
    current = [];
  };
  for (const line of text.split('\n')) {
    if (line.trim()) {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();

  const cleanTitle =
    (title && normalizeWhitespace(title)) || titleFromText(blocks[0]?.text ?? '');
  return { title: cleanTitle, blocks };
}

function titleFromText(text, maxWords = 8) {
  const words = text.split(' ');
  const head = words.slice(0, maxWords).join(' ');
  return words.length > maxWords ? `${head}…` : head || 'Pasted text';
}
