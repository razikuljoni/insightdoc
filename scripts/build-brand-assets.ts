/**
 * InsightDoc — Brand asset builder
 *
 * Generates the full production icon/OG set from the hand-authored SVG sources
 * in public/brand/. Run once after changing brand sources:
 *
 *   bun scripts/build-brand-assets.ts
 *
 * Outputs (Next.js file conventions + public/):
 *   src/app/icon.svg              — vector favicon (modern browsers)
 *   src/app/icon.png              — 512×512 raster fallback
 *   src/app/apple-icon.png        — 180×180 iOS home-screen
 *   src/app/favicon.ico           — multi-size legacy (16/32/48)
 *   src/app/opengraph-image.png   — 1200×630 social card
 *   src/app/twitter-image.png     — 1200×630 social card
 *   public/icons/icon-192.png     — web manifest
 *   public/icons/icon-512.png     — web manifest
 */
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const ROOT = process.cwd();
const BRAND = path.join(ROOT, 'public', 'brand');
const APP = path.join(ROOT, 'src', 'app');
const ICONS = path.join(ROOT, 'public', 'icons');

async function main() {
  const markSvg = await readFile(path.join(BRAND, 'logo-mark.svg'));
  const ogSvg = await readFile(path.join(BRAND, 'og-image.svg'));

  // --- Raster mark at every needed size -----------------------------------
  const sizes: Array<[number, string]> = [
    [16, '16'],
    [32, '32'],
    [48, '48'],
    [180, '180'],
    [192, '192'],
    [512, '512'],
  ];
  const rendered = new Map<number, Buffer>();
  for (const [size] of sizes) {
    rendered.set(size, await sharp(markSvg).resize(size, size).png().toBuffer());
  }

  await writeFile(path.join(APP, 'icon.png'), rendered.get(512)!);
  await writeFile(path.join(APP, 'apple-icon.png'), rendered.get(180)!);
  await writeFile(path.join(ICONS, 'icon-192.png'), rendered.get(192)!);
  await writeFile(path.join(ICONS, 'icon-512.png'), rendered.get(512)!);
  await writeFile(path.join(ROOT, 'public', 'brand', 'logo-mark.png'), rendered.get(512)!);

  // --- Vector favicon -------------------------------------------------------
  await writeFile(path.join(APP, 'icon.svg'), markSvg);

  // --- Legacy multi-size favicon.ico ---------------------------------------
  const tmp = await mkdtemp(path.join(tmpdir(), 'id-ico-'));
  const icoSources: string[] = [];
  for (const size of [16, 32, 48]) {
    const p = path.join(tmp, `icon-${size}.png`);
    await writeFile(p, rendered.get(size)!);
    icoSources.push(p);
  }
  const ico = await pngToIco(icoSources);
  await writeFile(path.join(APP, 'favicon.ico'), ico);

  // --- OpenGraph / Twitter card (mark composited onto the designed bg) -----
  const mark320 = await sharp(markSvg).resize(320, 320).png().toBuffer();
  const og = await sharp(ogSvg)
    .composite([{ input: mark320, left: 72, top: 170 }])
    .png()
    .toBuffer();
  await writeFile(path.join(APP, 'opengraph-image.png'), og);
  await writeFile(path.join(APP, 'twitter-image.png'), og);

  // --- Report ---------------------------------------------------------------
  for (const f of [
    'src/app/icon.svg', 'src/app/icon.png', 'src/app/apple-icon.png', 'src/app/favicon.ico',
    'src/app/opengraph-image.png', 'src/app/twitter-image.png',
    'public/icons/icon-192.png', 'public/icons/icon-512.png',
  ]) {
    const buf = await readFile(path.join(ROOT, f));
    console.log(`✓ ${f} (${(buf.byteLength / 1024).toFixed(1)} KB)`);
  }
}

main().catch((err) => {
  console.error('brand build failed:', err);
  process.exit(1);
});
