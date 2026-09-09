/**
 * Dev utility — generates a LARGE multi-page PDF (>24k extractable chars) so
 * the digest service's map-reduce path (context truncation → per-part notes →
 * reduce) can be exercised end-to-end. Pages are procedurally composed from
 * seeded sections so every run is deterministic but content stays varied.
 *
 * Run: bun scripts/make-large-pdf.ts <output-path>
 * Output: ~26 pages, ~34k chars — comfortably over the 24k single-shot budget.
 */
import { writeFileSync } from 'fs';

/** Section templates — each generates one page of ~1100-1400 chars. */
const SECTION_TEMPLATES: Array<(n: number) => string[]> = [
  (n) => [
    `APPENDIX ${String.fromCharCode(64 + ((n - 1) % 26) + 1)}.${n} REGIONAL OPERATIONS REVIEW`,
    '',
    `Regional entity ${n} delivered net sales of $${(120 + n * 13)}.${n % 10} million in the period,`,
    `representing ${(4 + (n % 7))}.${n % 9}% consolidated growth versus the comparable prior-year`,
    'period. Operating income for the region was $' + `${(18 + n * 2)}.4 million, translating to a`,
    `margin of ${(13 + (n % 5))}.${n % 9} percent, an improvement of ${(n % 40) + 20} basis points`,
    'year over year driven by procurement savings and factory utilization gains.',
    '',
    `Headcount in the region closed at ${(420 + n * 17).toLocaleString('en-US')} employees after the`,
    `commissioning of assembly line ${n} at the regional plant. Capital expenditure of`,
    `$${9 + n}.1 million was approved for the next phase of automation, with`,
    `first shipments expected in quarter ${(n % 4) + 1}. Local content requirements are satisfied at`,
    `${(61 + (n % 9))}% and the regional supply base passed its annual quality audit with a`,
    `defect rate of ${(n * 3 + 7)} parts per million across ${(240 + n * 12).toLocaleString('en-US')} inspected lots.`,
  ],
  (n) => [
    `SECTION ${n}. PRODUCT LINE ECONOMICS AND UNIT MARGINS`,
    '',
    `Product family P-${100 + n} shipped ${(14_200 + n * 1_310).toLocaleString('en-US')} units during the`,
    `period at an average selling price of $${(2_100 + n * 85).toLocaleString('en-US')}, generating`,
    `$${(29.8 + n * 2.9).toFixed(1)} million of recognized revenue. Unit cost declined ${(n % 9) + 1}.2%`,
    `on the strength of the redesign program, lifting gross margin to ${(34 + (n % 8))}.${n % 9}%.`,
    '',
    `The installed base for this family now stands at ${(96_000 + n * 7_400).toLocaleString('en-US')} systems,`,
    `of which ${(58 + (n % 10))}% carry an active service contract. Attach revenue for the quarter`,
    `was $${(6.4 + n * 0.7).toFixed(1)} million with renewal rates holding at ${(91 + (n % 6))}%. The`,
    `roadmap commits to a next-generation controller in fiscal ${2027 + (n % 2)} featuring onboard`,
    `predictive maintenance, expected to reduce service truck rolls by ${(18 + n)} percent.`,
  ],
  (n) => [
    `SECTION ${n + 10}. CONTRACT BACKLOG AND ORDER INTAKE`,
    '',
    `Order intake for the period reached $${(210 + n * 24)}.6 million, a ${(6 + (n % 9))}.${n % 9}% increase`,
    `over the prior period, bringing the twelve-month backlog to $${(680 + n * 71)}.2 million.`,
    `Book-to-bill stood at ${(1 + (n % 5) / 10 + 0.02).toFixed(2)}, and backlog conversion is expected`,
    `at ${(38 + (n % 8))}% within two fiscal quarters on current engineering capacity.`,
    '',
    `Major awards in the period include contract ${String.fromCharCode(64 + n)}-${n}${n}0 covering`,
    `deployment of ${(40 + n * 6).toLocaleString('en-US')} cells across the customer's network, valued at`,
    `$${(45 + n * 4)}.0 million, and a multi-year telemetry agreement adding $${(7 + n)}.5 million of`,
    `annual recurring revenue. Cancellation and scope-adjustment experience remained at or below`,
    `the ${(2 + (n % 3))}% long-run average, and no single customer represents more than`,
    `${(9 + (n % 6))}% of consolidated backlog, preserving diversification objectives.`,
  ],
  (n) => [
    `SECTION ${n + 20}. COMPLIANCE, TAX AND REGULATORY STATUS`,
    '',
    `The entity completed its statutory audit for fiscal year ${2024 + (n % 3)} without`,
    'qualification. Transfer pricing documentation was refreshed for the current cycle and the',
    `effective tax rate is projected at ${(23 + (n % 6))}.${n % 9}%, within the guided corridor of`,
    `22 to ${28 + (n % 4)} percent. No material uncertain tax positions were recognized in the`,
    'period and the deferred tax asset valuation allowance was unchanged.',
    '',
    `Regulatory filings covering product certification ${n} were accepted by the relevant`,
    `authorities on first submission. The compliance calendar for the next four quarters includes`,
    `${(5 + (n % 5))} attestations and ${(2 + (n % 4))} external assessments; all are on track. Data`,
    `protection impact assessments were completed for the ${n} processing activities introduced`,
    'this period, and records of processing were updated accordingly with the privacy office.',
  ],
];

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pageContent(lines: string[]): string {
  let out = 'BT\n/F1 12 Tf\n72 760 Td\n18 TL\n';
  for (const line of lines) {
    out += `(${esc(line)}) Tj T*\n`;
  }
  out += 'ET\n';
  return out;
}

function buildPdf(pageCount: number): Buffer {
  const objects: string[] = [];
  const pageObjIds: number[] = [];

  let nextId = 4;
  for (let p = 0; p < pageCount; p++) {
    const template = SECTION_TEMPLATES[p % SECTION_TEMPLATES.length];
    const pageId = nextId++;
    const contentId = nextId++;
    pageObjIds.push(pageId);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = pageContent(template(p + 1));
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  }

  const kids = pageObjIds.map((id) => `${id} 0 R`).join(' ');
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Count ${pageObjIds.length} /Kids [${kids}] >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

const out = process.argv[2] ?? '/tmp/insightdoc-large.pdf';
const pages = Number(process.argv[3] ?? 40);
const pdf = buildPdf(pages);
writeFileSync(out, pdf);
console.log(`Wrote ${out} (${pdf.length} bytes, ${pages} pages, ~${((pages * 773) / 1000).toFixed(0)}k chars${pages * 773 > 24_000 ? ' — over the 24k single-shot digest budget' : ''})`);
