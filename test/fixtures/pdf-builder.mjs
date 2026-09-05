import zlib from 'node:zlib';

// Minimal dependency-free PDF builder used by generate-fixtures.mjs and the
// PDF extraction unit tests. Each page is an array of text lines; lines are
// emitted with explicit line moves so pdf.js reports them with hasEOL.
export function pdfWithPages(pages) {
  const n = pages.length;
  const objs = [];
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(' ');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + n} 0 R >> >> /Contents ${4 + n + i} 0 R >>`,
    );
  }
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const lines of pages) {
    const ops = lines
      .map((l) => `(${l.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj T*`)
      .join('\n');
    const stream = `BT\n/F1 12 Tf\n72 740 Td\n14 TL\n${ops}\nET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let out = '%PDF-1.4\n';
  const offsets = [0];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// Builds a PDF whose pages are a single full-bleed raster image each, with NO
// text layer — i.e. a "scanned" PDF. Used to exercise the OCR fallback: extract
// returns no text for these pages, which triggers render + OCR.
//
// Each input is { rgb: Buffer(width*height*3), width, height } — 8-bit RGB. The
// pixels are embedded losslessly as a FlateDecode image XObject (raw RGB + zlib,
// no JPEG encoder variance, no PNG predictors), so the fixture is byte-stable.
// Built with Buffers (not string concat) because the deflated stream is binary.
export function pdfWithImagePages(images) {
  const n = images.length;
  const objs = []; // each entry: Buffer with the object body (between "obj\n" and "\nendobj")

  objs.push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  const kids = images.map((_, i) => `${3 + i} 0 R`).join(' ');
  objs.push(Buffer.from(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`, 'latin1'));

  const baseObj = 2 + n; // last page object number; streams follow after it
  images.forEach((img, i) => {
    const contentNum = baseObj + 1 + i * 2;
    const imageNum = baseObj + 2 + i * 2;
    objs.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${img.width} ${img.height}] ` +
          `/Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>`,
        'latin1',
      ),
    );
  });
  for (const img of images) {
    // Map the unit image square onto the whole page (image points = pixels here).
    const content = `q ${img.width} 0 0 ${img.height} 0 0 cm /Im0 Do Q`;
    objs.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`, 'latin1'));
    const comp = zlib.deflateSync(img.rgb);
    objs.push(
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${comp.length} >>\nstream\n`,
          'latin1',
        ),
        comp,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    );
  }

  const chunks = [];
  let pos = 0;
  const push = (buf) => {
    chunks.push(buf);
    pos += buf.length;
  };
  const offsets = [0];
  push(Buffer.from('%PDF-1.4\n', 'latin1'));
  objs.forEach((body, i) => {
    offsets.push(pos);
    push(Buffer.from(`${i + 1} 0 obj\n`, 'latin1'));
    push(body);
    push(Buffer.from('\nendobj\n', 'latin1'));
  });
  const xrefStart = pos;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
