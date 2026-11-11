#!/usr/bin/env node
/**
 * Render an alignment proof: the original scanned page image with the exported
 * PDF text-layer boxes drawn on top, plus pixel-overlap statistics.
 *
 * Usage:
 *   node scripts/render-text-layer-overlay.mjs <page.png> <layer.json> <out.png> [out-stats.json]
 */
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const [imagePath, layerPath, outPath, statsPath] = process.argv.slice(2);
if (!imagePath || !layerPath || !outPath) {
  console.error('Usage: node scripts/render-text-layer-overlay.mjs <page.png> <layer.json> <out.png> [out-stats.json]');
  process.exit(2);
}

const [imageBytes, layer] = await Promise.all([
  fs.readFile(imagePath),
  fs.readFile(layerPath, 'utf8').then((text) => JSON.parse(text)),
]);
const imageBase64 = imageBytes.toString('base64');
const imageMime = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';

const boxes = layer.items.map((item) => {
  const sx = layer.pageWidth;
  const sy = layer.pageHeight;
  return {
    text: item.text,
    left: (item.x / sx) * 1000,
    top: ((sy - (item.y + item.height)) / sy) * 1000,
    width: (item.width / sx) * 1000,
    height: (item.height / sy) * 1000,
  };
});

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
  const svgRects = boxes
    .map(
      (box) =>
        `<rect x="${box.left.toFixed(3)}" y="${box.top.toFixed(3)}" width="${box.width.toFixed(3)}" height="${box.height.toFixed(3)}" fill="rgba(255,0,0,0.10)" stroke="rgba(220,0,0,0.85)" stroke-width="0.7"/>`,
    )
    .join('');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
    <div id="stage" style="position:relative;width:1000px">
      <img id="page" src="data:${imageMime};base64,${imageBase64}" style="width:1000px;display:block"/>
      <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">${svgRects}</svg>
    </div>
  </body></html>`);
  await page.waitForFunction(() => {
    const img = document.getElementById('page');
    return img && img.complete && img.naturalWidth > 0;
  });
  const imgHeight = await page.evaluate(() => {
    const img = document.getElementById('page');
    return img.getBoundingClientRect().height;
  });
  await page.setViewportSize({ width: 1000, height: Math.ceil(imgHeight) });
  await page.screenshot({ path: outPath, fullPage: true });

  const stats = await page.evaluate((boxesIn) => {
    const img = document.getElementById('page');
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const isDark = (x, y) => {
      const i = (y * canvas.width + x) * 4;
      return data[i] < 128 && data[i + 1] < 128 && data[i + 2] < 128;
    };
    const sx = canvas.width / 1000;
    const sy = canvas.height / 1000;
    const mask = new Uint8Array(canvas.width * canvas.height);
    let inkInBoxes = 0;
    let totalInk = 0;
    const coverages = [];
    const offsets = [];
    for (const box of boxesIn) {
      const x0 = Math.max(0, Math.round(box.left * sx));
      const y0 = Math.max(0, Math.round(box.top * sy));
      const x1 = Math.min(canvas.width, Math.round((box.left + box.width) * sx));
      const y1 = Math.min(canvas.height, Math.round((box.top + box.height) * sy));
      let dark = 0;
      let sumX = 0;
      let sumY = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          if (!isDark(x, y)) continue;
          dark += 1;
          sumX += x;
          sumY += y;
          mask[y * canvas.width + x] = 1;
        }
      }
      if (dark > 0) {
        coverages.push(dark / Math.max(1, (x1 - x0) * (y1 - y0)));
        const cx = sumX / dark;
        const cy = sumY / dark;
        offsets.push(Math.hypot(cx - (x0 + x1) / 2, cy - (y0 + y1) / 2));
      }
    }
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (isDark(x, y)) totalInk += 1;
        if (mask[y * canvas.width + x]) inkInBoxes += 1;
      }
    }
    const sorted = [...coverages].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const mean = coverages.reduce((sum, value) => sum + value, 0) / Math.max(1, coverages.length);
    const meanOffset = offsets.reduce((sum, value) => sum + value, 0) / Math.max(1, offsets.length);
    return {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      boxCount: boxesIn.length,
      boxesWithInk: coverages.length,
      medianInkCoverage: Number(median.toFixed(4)),
      meanInkCoverage: Number(mean.toFixed(4)),
      meanCentroidOffsetPx: Number(meanOffset.toFixed(2)),
      textBoxInkRatio: Number((inkInBoxes / Math.max(1, totalInk)).toFixed(4)),
      pageInkRatio: Number((totalInk / (canvas.width * canvas.height)).toFixed(4)),
    };
  }, boxes);

  if (statsPath) await fs.writeFile(statsPath, JSON.stringify({ ...stats, layer: layerPath, image: imagePath }, null, 2));
  console.log('[overlay]', JSON.stringify(stats));
  console.log('[overlay] image:', outPath);
} finally {
  await browser.close();
}
