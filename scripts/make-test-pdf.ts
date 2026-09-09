/**
 * Dev utility — generates a realistic multi-page PDF (raw PDF 1.4 syntax with a
 * real text layer) so the ingestion pipeline can be exercised end-to-end.
 * Run: bun scripts/make-test-pdf.ts <output-path> [variant]
 * A non-empty variant stamps a unique line into page 1 so consecutive QA
 * uploads produce different content hashes (duplicate detection stays happy).
 */
import { writeFileSync } from 'fs';

const PAGES: string[][] = [
  [
    'ACME Industrial Holdings Ltd.',
    'Form 10-Q Quarterly Report - Q3 FY2026',
    '',
    'SECTION 1A. RISK FACTORS',
    '',
    'The Company faces significant supply chain delays arising from constrained',
    'semiconductor availability and port congestion in the Pacific corridor.',
    'Management estimates these delays could reduce FY2026 operating margin by',
    'up to 180 basis points if unresolved by the end of Q2 FY2027.',
    '',
    'Additionally, currency exposure to the Euro and Yen may introduce earnings',
    'volatility of approximately 4% quarter over quarter under current hedge',
    'coverage ratios of 62 percent.',
  ],
  [
    'SECTION 2. LIQUIDITY AND CAPITAL RESOURCES',
    '',
    'As of September 30, 2026, cash and cash equivalents totaled $842.6 million,',
    'an increase of $57.2 million versus the prior fiscal quarter end. The',
    'increase was primarily driven by strong operating cash flow of $191.3',
    'million, partially offset by capital expenditures of $88.9 million.',
    '',
    'The Company maintains a revolving credit facility of $500 million with',
    'JPMorgan Chase, of which $120 million was drawn as of the reporting date.',
    'The debt covenant requires a maximum leverage ratio of 3.5x net debt to',
    'EBITDA; the Company stands at 1.8x, providing ample covenant headroom.',
  ],
  [
    'SECTION 3. REVENUE RECOGNITION AND SEGMENT PERFORMANCE',
    '',
    'Total Q3 FY2026 revenue was $1.42 billion, up 11.4% year over year.',
    'The Industrial Automation segment contributed $610 million (43%), the',
    'Robotics segment $454 million (32%), and the Energy Systems segment',
    '$356 million (25%).',
    '',
    'Recurring revenue, including multi-year service contracts and SaaS',
    'telemetry subscriptions, reached 28% of total revenue, up from 22% in',
    'the prior year period, reflecting the deliberate shift toward as-a-',
    'service business models across the installed base.',
  ],
  [
    'SECTION 4. LEGAL PROCEEDINGS',
    '',
    'On May 14, 2026, a putative class action was filed in the Northern',
    'District of California alleging that the Company FactoryOS platform',
    'infringed U.S. Patent 10,442,301 covering adaptive robotics scheduling.',
    'The Company believes the claims are without merit and intends to defend',
    'the litigation vigorously. An adverse outcome could require damages',
    'estimated at no more than $34 million based on current discovery.',
    '',
    'The Company is also subject to an ongoing SEC inquiry regarding revenue',
    'timing in prior fiscal years; management has cooperated fully and believes',
    'the matter will resolve without material financial statement impact.',
  ],
  [
    'SECTION 5. CYBERSECURITY AND DATA PROTECTION',
    '',
    'The Company maintains an information security program aligned to the NIST',
    'Cybersecurity Framework 2.0. During Q3 FY2026, no material incidents were',
    'reported. Third-party penetration testing is conducted semi-annually, and',
    'the Security Operations Center operates 24/7 with a mean time to detect',
    'of 14 minutes and mean time to respond of 41 minutes.',
    '',
    'Residual cyber risk is mitigated through a $150 million cyber insurance',
    'policy with a $5 million retention, covering business interruption, data',
    'recovery, and regulatory defense costs.',
  ],
  [
    'SECTION 6. HUMAN CAPITAL',
    '',
    'As of September 30, 2026, the Company employed 12,847 full-time employees',
    'across 21 countries. Voluntary attrition improved to 8.2% on a trailing',
    'twelve month basis. The Company invested $46.7 million in employee',
    'training and development during the first nine months of FY2026.',
    '',
    'The Board approved a new equity refresh program granting RSUs covering',
    'up to 1.2% of outstanding shares to key engineering talent, effective',
    'beginning fiscal Q1 FY2027.',
  ],
  [
    'SECTION 7. ENVIRONMENTAL MATTERS AND SUSTAINABILITY',
    '',
    'The Company has committed to carbon neutrality for Scope 1 and Scope 2',
    'emissions by fiscal year 2030. During the reporting period, renewable',
    'sources supplied 54% of total electricity consumption, and the Company',
    'retired 68,000 metric tons of CO2 equivalent through verified offsets.',
    '',
    'Capital expenditure for decarbonization projects totaled $27.4 million in',
    'the first nine months of FY2026, primarily for heat recovery systems at',
    'the Milwaukee and Stuttgart manufacturing plants.',
  ],
  [
    'SECTION 8. OUTLOOK AND FORWARD-LOOKING STATEMENTS',
    '',
    'Management expects full year FY2026 revenue growth of 9% to 11% and',
    'adjusted operating margin between 16.8% and 17.4%. These forward-looking',
    'statements are subject to risks including macroeconomic softness in',
    'European industrial demand, timing of large automation orders, and',
    'component cost inflation described in Section 1A.',
    '',
    'This report is furnished pursuant to the securities laws of the United',
    'States and should be read together with the FY2025 Annual Report on',
    'Form 10-K filed with the Commission.',
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

function buildPdf(): Buffer {
  const objects: string[] = [];
  const pageObjIds: number[] = [];

  let nextId = 4;
  for (const lines of PAGES) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageObjIds.push(pageId);
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    const stream = pageContent(lines);
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

const out = process.argv[2] ?? '/tmp/insightdoc-test.pdf';
const variant = process.argv[3] ?? '';
if (variant) {
  PAGES[0].push('', `QA variant stamp: ${variant} (${new Date().toISOString()})`);
}
writeFileSync(out, buildPdf());
console.log(`Wrote ${out} (${PAGES.length} pages)${variant ? ` · variant=${variant}` : ''}`);
