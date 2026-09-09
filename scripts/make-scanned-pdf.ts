/**
 * InsightDoc — scanned-PDF test fixture generator.
 *
 * Produces an IMAGE-ONLY PDF (JPEG embedded via DCTDecode, zero text layer)
 * so the ingestion worker's OCR fallback can be exercised end-to-end:
 *
 *   bun scripts/make-scanned-pdf.ts /tmp/scanned.pdf
 *
 * The page is rendered with @napi-rs/canvas (real glyphs, real rasterization)
 * and hand-wrapped into a minimal single-page PDF — no extra PDF dependency.
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const ARG = process.argv[2];
if (!ARG) {
  console.error('Usage: bun scripts/make-scanned-pdf.ts /tmp/scanned.pdf [variant-stamp]');
  console.error('  variant-stamp: optional footer text baked into the image — changes the content hash');
  console.error('  so repeated QA runs do not collide with the upload de-duplication checksum.');
  process.exit(1);
}
const VARIANT = process.argv[3] ?? '';

// @napi-rs/canvas ships no fonts — register the bundled DejaVu explicitly.
const fontPath = path.join(import.meta.dir, 'assets', 'DejaVuSans.ttf');
GlobalFonts.registerFromPath(fontPath, 'DocSans');

const W = 1240;
const H = 1600;

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');

ctx.fillStyle = '#ffffff';
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = '#111111';

ctx.font = 'bold 44px DocSans';
ctx.fillText('Quarterly Operations Report', 80, 110);

ctx.font = '26px DocSans';
const PARAGRAPHS = [
  'Total Q3 FY2026 revenue was 1.42 billion dollars, up 11.4 percent year over year, driven by strong demand across every reporting segment.',
  'The Industrial Automation segment contributed 610 million dollars, representing 43 percent of total revenue for the quarter.',
  'The Robotics segment generated 454 million dollars, about 32 percent of revenue, while the Energy Systems segment added 356 million dollars, or 25 percent.',
  'Recurring revenue, including multi-year service contracts and SaaS telemetry subscriptions, reached 28 percent of total revenue, up from 22 percent in the prior year period.',
  'Cash and cash equivalents totaled 842.6 million dollars as of September 30, 2026, an increase of 57.2 million dollars versus the prior fiscal quarter.',
  'Management estimates that semiconductor supply chain delays could reduce the FY2026 operating margin by up to 180 basis points if unresolved by the end of Q2 FY2027.',
  'The company faces a patent infringement lawsuit with potential damages estimated at no less than 62 million dollars, currently in the discovery phase.',
];
let y = 210;
for (const paragraph of PARAGRAPHS) {
  const words = paragraph.split(' ');
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > W - 160) {
      ctx.fillText(line, 80, y);
      y += 46;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    ctx.fillText(line, 80, y);
    y += 46;
  }
  y += 28;
}

// Optional footer stamp — makes each generated scan content-unique.
if (VARIANT) {
  ctx.font = '20px DocSans';
  ctx.fillStyle = '#555555';
  ctx.fillText(`Scan ref: ${VARIANT} — generated for ingestion QA`, 80, H - 90);
}

const jpeg = canvas.toBuffer('image/jpeg', 0.92);

// ── Minimal single-page PDF wrapping the JPEG ────────────────────────────────
const objects: string[] = [];
const offsets: number[] = [];
let out = Buffer.alloc(0);

const push = (chunk: string | Buffer) => {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk;
  out = Buffer.concat([out, buf]);
};

push('%PDF-1.4\n');

const addObj = (num: number, body: (string | Buffer)[]) => {
  offsets[num] = out.length;
  push(`${num} 0 obj\n`);
  for (const b of body) push(b);
  push('\nendobj\n');
};

addObj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
addObj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
addObj(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ', String(W), ' ', String(H), '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>']);
addObj(4, [
  `<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  jpeg,
  '\nendstream',
]);
const content = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ`;
addObj(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);

const xrefStart = out.length;
push('xref\n0 6\n0000000000 65535 f \n');
for (let i = 1; i <= 5; i++) {
  push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
}
push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

writeFileSync(ARG, out);
console.log(`scanned-style PDF written: ${ARG} (${out.length} bytes, ${W}x${H} image, no text layer)`);
