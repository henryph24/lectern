// Regenerates the committed PDF fixtures: `node test/fixtures/generate-fixtures.mjs`
// sample.pdf — 2 pages of text lines incl. a hyphenated line break (paragraph reconstruction cases)
// empty.pdf  — 1 page with no text ops (NO_TEXT_LAYER case)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfWithPages } from './pdf-builder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const samplePages = [
  [
    'This fixture exercises the PDF paragraph reconstruction logic. It contains a docu-',
    'ment that must be re-joined.',
    'A second paragraph begins on a new line and continues with enough words to span',
    'multiple lines of justified text before it also reaches a clean ending.',
  ],
  [
    'Page two contains its own paragraph so the extractor must keep page order intact.',
    'It ends here.',
    'A trailing third paragraph closes the fixture document.',
  ],
];

writeFileSync(path.join(here, 'sample.pdf'), pdfWithPages(samplePages));
writeFileSync(path.join(here, 'empty.pdf'), pdfWithPages([[]]));
console.log('Wrote sample.pdf and empty.pdf');
