import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildTextPdf } from '../src/lib/textPdf';
import type { OcrPageResult } from '../src/lib/ocr';

async function makeBlankPdf(pageCount = 2): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    pdf.addPage([612, 792]);
  }
  return pdf.save();
}

function ocrPage(page: number, confidence: number, text: string): OcrPageResult {
  return {
    page,
    ocrText: text,
    confidence,
    lines: [
      {
        text: text.slice(0, 40),
        confidence,
        bbox: { x0: 80, y0: 100, x1: 900, y1: 150 },
      },
    ],
    canvasWidth: 1700,
    canvasHeight: 2200,
    pageWidth: 612,
    pageHeight: 792,
    language: 'eng',
    durationMs: 900,
  };
}

describe('buildTextPdf', () => {
  it('high mode only writes high-accuracy pages', async () => {
    const original = await makeBlankPdf();
    const results = [
      ocrPage(1, 94, 'The theory of relativity is based on two postulates.'),
      ocrPage(2, 30, 'blurry noisy scan with uncertain words'),
    ];

    const high = await buildTextPdf({ originalBytes: original, results, mode: 'high' });
    expect(high.totalPages).toBe(2);
    expect(high.textPages).toBe(1);
    expect(high.skippedPages).toEqual([2]);
    expect(high.averageConfidence).toBeCloseTo(62);
    expect(high.usedCjkFont).toBe(false);
    expect(high.warnings.join(' ')).toContain('中文字体');

    const all = await buildTextPdf({ originalBytes: original, results, mode: 'all' });
    expect(all.textPages).toBe(2);
    expect(all.skippedPages).toEqual([]);
  });

  it('honours a stricter confidence threshold', async () => {
    const original = await makeBlankPdf(1);
    const results = [ocrPage(1, 94, 'The theory of relativity is based on two postulates.')];

    const strict = await buildTextPdf({
      originalBytes: original,
      results,
      mode: 'high',
      threshold: 99,
    });
    expect(strict.textPages).toBe(0);
    expect(strict.skippedPages).toEqual([1]);
    expect(strict.bytes.byteLength).toBeGreaterThan(100);
  });

  it('uses manually edited text for a page and keeps the PDF loadable', async () => {
    const original = await makeBlankPdf(1);
    const results = [ocrPage(1, 94, 'The theory of relativity is based on two postulates.')];

    const exported = await buildTextPdf({
      originalBytes: original,
      results,
      mode: 'high',
      editedText: new Map([[1, 'EDITED-PAGE-ONE corrected by the user']]),
    });
    expect(exported.textPages).toBe(1);
    expect(exported.skippedPages).toEqual([]);

    const reloaded = await PDFDocument.load(exported.bytes);
    expect(reloaded.getPageCount()).toBe(1);
  });
});

describe('word-level text layer alignment', () => {
  it('places each OCR word at its box position and preserves extractable text', async () => {
    const original = await makeBlankPdf(1);
    const result: OcrPageResult = {
      page: 1,
      ocrText: 'CONTENTS Introduction',
      confidence: 95,
      lines: [
        {
          text: 'CONTENTS Introduction',
          confidence: 95,
          bbox: { x0: 100, y0: 100, x1: 900, y1: 160 },
          words: [
            { text: 'CONTENTS', confidence: 97, bbox: { x0: 100, y0: 100, x1: 380, y1: 160 } },
            { text: 'Introduction', confidence: 93, bbox: { x0: 500, y0: 100, x1: 900, y1: 160 } },
          ],
        },
      ],
      canvasWidth: 1700,
      canvasHeight: 2200,
      pageWidth: 612,
      pageHeight: 792,
      language: 'eng',
      durationMs: 900,
    };

    const exported = await buildTextPdf({ originalBytes: original, results: [result], mode: 'high' });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(exported.bytes) })
      .promise;
    try {
      const page = await doc.getPage(1);
      const content = await page.getTextContent();
      const items = content.items.filter(
        (item): item is typeof item & { str: string; transform: number[] } =>
          'str' in item && 'transform' in item && (item as { str: string }).str.trim().length > 0,
      );
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.str).join(' ')).toContain('CONTENTS');
      expect(items.map((item) => item.str).join(' ')).toContain('Introduction');

      const expectedX = 100 / 1700 * 612;
      expect(Math.abs(items[0].transform[4] - expectedX)).toBeLessThan(2);
      expect(items[0].transform[4]).toBeLessThan(items[1].transform[4]);
    } finally {
      await doc.loadingTask.destroy();
    }
  });
});
