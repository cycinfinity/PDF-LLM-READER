import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageText } from './types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type { PDFDocumentProxy };

// pdf.js >= 6 decodes JBIG2 / JPEG2000 images and ICC profiles through WASM, and
// needs cMaps / standard fonts for many real-world PDFs. These assets live in
// public/pdfjs and are served by Vite (dev) and by the built app (production).
const assetBase = import.meta.env.BASE_URL.replace(/\/$/, '');
const PDF_ASSET_OPTIONS = {
  wasmUrl: `${assetBase}/pdfjs/wasm/`,
  cMapUrl: `${assetBase}/pdfjs/cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${assetBase}/pdfjs/standard_fonts/`,
};

export async function loadPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(data), ...PDF_ASSET_OPTIONS });
  return task.promise;
}

function normalizePageText(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractSinglePage(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<PageText> {
  const page = await doc.getPage(pageNumber);
  try {
    const content = await page.getTextContent({ includeMarkedContent: false });
    let text = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      text += item.str;
      text += item.hasEOL ? '\n' : ' ';
    }
    return { page: pageNumber, text: normalizePageText(text) };
  } finally {
    page.cleanup();
  }
}

/** Extract text page-by-page with small bounded concurrency (keeps the UI responsive). */
export async function extractPageTexts(
  doc: PDFDocumentProxy,
  onProgress?: (done: number, total: number) => void,
): Promise<PageText[]> {
  const total = doc.numPages;
  const results: PageText[] = new Array(total);
  let completed = 0;
  let cursor = 1;
  const concurrency = Math.min(4, total);

  async function worker(): Promise<void> {
    while (true) {
      const pageNumber = cursor;
      cursor += 1;
      if (pageNumber > total) return;
      results[pageNumber - 1] = await extractSinglePage(doc, pageNumber);
      completed += 1;
      onProgress?.(completed, total);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
