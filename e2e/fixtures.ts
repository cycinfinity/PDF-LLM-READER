import { PDFDocument } from 'pdf-lib';
import type { Page } from '@playwright/test';

/**
 * Builds a 2-page "scanned" PDF for E2E: each page is a PNG screenshot of an
 * HTML page embedded into an image-only PDF. The app must OCR it like a real
 * scanner output.
 */
export async function makeScannedPdf(page: Page): Promise<Buffer> {
  const generator = await page.context().newPage();
  await generator.setViewportSize({ width: 900, height: 1200 });
  const pages = [
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
      <style>
        body { margin: 0; padding: 90px 80px; font-family: Georgia, "Times New Roman", serif;
               color: #111; background: #fff; }
        h1 { font-size: 42px; letter-spacing: 1px; margin: 0 0 36px; }
        p { font-size: 25px; line-height: 1.65; margin: 0 0 24px; }
      </style></head><body>
      <h1>RELATIVITY NOTES</h1>
      <p>The theory of relativity is based on two postulates: the principle of
         relativity and the constancy of the speed of light.</p>
      <p>This page explains why observers in different inertial frames disagree
         about simultaneity while agreeing about the laws of physics.</p>
    </body></html>`,
    `<!doctype html><html lang="en"><head><meta charset="utf-8" />
      <style>
        body { margin: 0; padding: 90px 80px; font-family: Georgia, "Times New Roman", serif;
               color: #111; background: #fff; }
        h1 { font-size: 42px; margin: 0 0 36px; }
        p { font-size: 25px; line-height: 1.65; margin: 0 0 24px; }
      </style></head><body>
      <h1>TWO POSTULATES</h1>
      <p>The speed of light in vacuum is approximately 300,000 kilometers per
         second, independent of the motion of the source or the observer.</p>
      <p>Mass and energy are equivalent, as summarized by the relation
         E equals m c squared.</p>
    </body></html>`,
  ];

  const pngs: Buffer[] = [];
  for (const html of pages) {
    await generator.setContent(html);
    pngs.push(await generator.screenshot({ type: 'png' }));
  }
  await generator.close();

  const pdf = await PDFDocument.create();
  for (const png of pngs) {
    const image = await pdf.embedPng(png);
    const sheet = pdf.addPage([612, 792]);
    sheet.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  }
  return Buffer.from(await pdf.save());
}

/** Builds a normal text-layer PDF used as a regression fixture for Q&A. */
export async function makeTextPdf(page: Page): Promise<Buffer> {
  const generator = await page.context().newPage();
  await generator.setContent(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
      .page { padding: 28mm; font-size: 19px; line-height: 1.9; page-break-after: always; }
      h1 { font-size: 26px; margin-bottom: 18px; }
    </style>
  </head>
  <body>
    <div class="page">
      <h1>相对论讲义</h1>
      <p>第一页：狭义相对论由爱因斯坦提出，用于描述高速运动下的时空关系。</p>
    </div>
    <div class="page">
      <h1>两条基本假设</h1>
      <p>相对论基于相对性原理与光速不变原理。</p>
      <p>光速在真空中约为每秒三十万公里，与光源和观察者的运动无关。</p>
    </div>
    <div class="page">
      <h1>质能等价</h1>
      <p>质能等价关系为 E = mc²，这是第三页的结论。</p>
    </div>
  </body>
</html>`);
  const buffer = await generator.pdf({ format: 'A4' });
  await generator.close();
  return buffer;
}

/** Builds a multi-page text PDF long enough to trigger summary mode (> 6000 chars). */
export async function makeLongTextPdf(page: Page): Promise<Buffer> {
  const titles = ['相对论讲义', '两条基本假设', '质能等价'];
  const paragraphs = Array.from({ length: 16 }, (_, index) =>
    `第${index + 1}段：狭义相对论讨论惯性参考系、光速不变原理、时间膨胀与质能等价，段落编号 P${index + 1}。`,
  ).join('');
  const pages = Array.from({ length: 10 }, (_, pageIndex) => `
    <div class="page">
      <h1>${titles[pageIndex % titles.length]}</h1>
      <p>${paragraphs}第${pageIndex + 1}页结束标记 PAGE${pageIndex + 1}。</p>
    </div>`).join('');
  const generator = await page.context().newPage();
  await generator.setContent(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif; }
      .page { padding: 22mm; font-size: 15px; line-height: 1.8; page-break-after: always; }
      h1 { font-size: 24px; margin-bottom: 12px; }
    </style>
  </head>
  <body>${pages}</body>
</html>`);
  const buffer = await generator.pdf({ format: 'A4' });
  await generator.close();
  return buffer;
}
