import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
import { htmlToBlocks, normalizeWhitespace } from './blocks.js';
import { safeFetch, readCappedText, BlockedAddressError } from '../safe-fetch.js';
import { clampTitle } from '../limits.js';

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export class ExtractError extends Error {
  constructor(message, { status = 422, suggestPasteText = false } = {}) {
    super(message);
    this.status = status;
    this.suggestPasteText = suggestPasteText;
  }
}

export async function extractFromUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtractError('That does not look like a valid URL', { status: 400 });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ExtractError('Only http(s) URLs are supported', { status: 400 });
  }

  let res;
  try {
    res = await safeFetch(parsed, {
      headers: {
        'User-Agent': DESKTOP_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      throw new ExtractError('That URL points to a private or local address, which is not allowed', {
        status: 400,
      });
    }
    const reason = err?.name === 'TimeoutError' ? 'the request timed out' : 'a network error occurred';
    throw new ExtractError(`Could not reach that page (${reason})`, {
      status: 502,
      suggestPasteText: true,
    });
  }

  if (!res.ok) {
    throw new ExtractError(
      `The site responded with HTTP ${res.status} — it may block automated readers`,
      { status: 502, suggestPasteText: true },
    );
  }

  let html;
  try {
    html = await readCappedText(res);
  } catch (err) {
    if (err instanceof BlockedAddressError) {
      throw new ExtractError('That page is too large to read', { status: 413, suggestPasteText: true });
    }
    throw err;
  }
  const dom = new JSDOM(html, { url: res.url || parsed.href });
  const article = new Readability(dom.window.document).parse();
  if (!article?.content) {
    throw new ExtractError('No readable article found on that page', {
      status: 422,
      suggestPasteText: true,
    });
  }

  const blocks = htmlToBlocks(article.content);
  if (blocks.length === 0) {
    throw new ExtractError('The article appears to be empty', {
      status: 422,
      suggestPasteText: true,
    });
  }

  const title = normalizeWhitespace(article.title ?? '') || parsed.hostname;
  if (blocks[0].type !== 'h1') {
    blocks.unshift({ type: 'h1', text: title });
  }

  return {
    title,
    byline: clampTitle(normalizeWhitespace(article.byline ?? '')) || undefined,
    siteName: clampTitle(normalizeWhitespace(article.siteName ?? '')) || undefined,
    blocks,
  };
}
