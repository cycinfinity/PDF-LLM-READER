#!/usr/bin/env node
/**
 * Extract PDF text-layer item boxes (page 1 by default) for alignment checks.
 * Usage: node scripts/analyze-text-layer.mjs <pdf> [page] [out.json]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('Usage: node scripts/analyze-text-layer.mjs <pdf> [page] [out.json]');
  process.exit(2);
}
const pageNumber = Number(process.argv[3] ?? 1);
const outPath = process.argv[4] ?? `/tmp/text-layer-page-${pageNumber}.json`;

const data = new Uint8Array(await fs.readFile(pdfPath));
const doc = await pdfjs.getDocument({ data }).promise;
const page = await doc.getPage(pageNumber);
const viewport = page.getViewport({ scale: 1 });
const content = await page.getTextContent();

const items = [];
for (const raw of content.items) {
  if (!('str' in raw)) continue;
  const text = raw.str.trim();
  if (!text) continue;
  const transform = raw.transform;
  const height = raw.height || Math.abs(transform[3]) || 10;
  items.push({
    text,
    x: transform[4],
    y: transform[5],
    width: raw.width || 0,
    height,
    fontSize: Math.hypot(transform[0], transform[1]),
  });
}

const text = items.map((item) => item.text).join(' ');
await fs.writeFile(
  outPath,
  JSON.stringify(
    {
      pdf: path.resolve(pdfPath),
      page: pageNumber,
      pageWidth: viewport.width,
      pageHeight: viewport.height,
      itemCount: items.length,
      textSample: text.slice(0, 300),
      items,
    },
    null,
    2,
  ),
);
console.log(`[text-layer] page ${pageNumber}: ${items.length} items, page ${viewport.width}x${viewport.height}`);
console.log(`[text-layer] ${text.slice(0, 160)}`);
console.log(`[text-layer] JSON: ${outPath}`);
await doc.loadingTask.destroy();
