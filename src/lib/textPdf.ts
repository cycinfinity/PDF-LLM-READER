import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { evaluatePageAccuracy, DEFAULT_HIGH_CONFIDENCE_THRESHOLD } from './ocrAccuracy';
import type { OcrPageResult } from './ocr';

export type ConversionMode = 'high' | 'all';

export interface BuildTextPdfOptions {
  originalBytes: ArrayBuffer | Uint8Array;
  results: OcrPageResult[];
  mode: ConversionMode;
  threshold?: number;
  /** Page number (1-based) -> user edited text. */
  editedText?: Map<number, string>;
  onProgress?: (done: number, total: number) => void;
}

export interface BuildTextPdfResult {
  bytes: Uint8Array;
  totalPages: number;
  textPages: number;
  skippedPages: number[];
  averageConfidence: number;
  usedCjkFont: boolean;
  warnings: string[];
}

const CJK_FONT_CANDIDATES = [
  '/fonts/NotoSansSC-Regular.ttf',
  '/fonts/NotoSansSC-Thin.ttf',
  '/fonts/NotoSansSC-ExtraLight.ttf',
];

async function tryLoadCjkFont(): Promise<ArrayBuffer | null> {
  for (const url of CJK_FONT_CANDIDATES) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > 100_000) return buffer;
    } catch {
      // Optional asset: keep trying the next candidate.
    }
  }
  return null;
}

const LATIN_FALLBACK = /[^\x20-\x7E\u00A0-\u00FF]/g;

const HELVETICA_DESCENT_RATIO = 0.207;

function fitSizeForHeight(heightPt: number): number {
  return Math.max(4, Math.min(24, heightPt * 0.82));
}

/**
 * Draw one invisible word with its baseline and width matched to the OCR box.
 * The font size is derived from the box height, then adjusted so the rendered
 * advance fits the box width (character spacing absorbs the remaining delta).
 */
function drawInvisibleWord(
  page: PDFPage,
  text: string,
  bbox: { x0: number; y0: number; x1: number; y1: number },
  result: OcrPageResult,
  font: PDFFont,
): boolean {
  const x = Math.max(0, (bbox.x0 / result.canvasWidth) * result.pageWidth);
  const width = Math.max(0, ((bbox.x1 - bbox.x0) / result.canvasWidth) * result.pageWidth);
  const heightPt = ((bbox.y1 - bbox.y0) / result.canvasHeight) * result.pageHeight;
  if (width < 0.5 || heightPt < 1) return false;

  // pdf-lib has no character-spacing option, so fit the word by choosing a
  // font size whose natural advance matches the OCR box width. Height is an
  // upper bound; long words may end up slightly smaller than the line box.
  const widthPerPt = Math.max(0.01, font.widthOfTextAtSize(text, 1));
  const widthSize = width / widthPerPt;
  const size = Math.max(4, Math.min(fitSizeForHeight(heightPt), widthSize));
  const baseline =
    result.pageHeight -
    (bbox.y1 / result.canvasHeight) * result.pageHeight +
    size * HELVETICA_DESCENT_RATIO;
  try {
    page.drawText(text, {
      x,
      y: Math.max(0, Math.min(result.pageHeight - size, baseline)),
      size,
      font,
      color: rgb(0, 0, 0),
      opacity: 0,
    });
    return true;
  } catch {
    return false;
  }
}

function drawOcrLines(
  page: PDFPage,
  result: OcrPageResult,
  font: PDFFont,
  safeForWinAnsi: boolean,
): number {
  let skippedChars = 0;
  for (const line of result.lines) {
    const words =
      line.words && line.words.length > 0
        ? line.words
        : [{ text: line.text, confidence: line.confidence, bbox: line.bbox }];
    for (const word of words) {
      let text = word.text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (safeForWinAnsi) {
        const cleaned = text.replace(LATIN_FALLBACK, '');
        skippedChars += text.length - cleaned.length;
        text = cleaned.trim();
        if (!text) continue;
      }
      if (!drawInvisibleWord(page, text, word.bbox, result, font)) {
        skippedChars += text.length;
      }
    }
  }
  return skippedChars;
}

/** Draw manually edited text as an invisible full-page text layer (top to bottom). */
function drawEditedText(
  page: PDFPage,
  result: OcrPageResult,
  text: string,
  font: PDFFont,
  safeForWinAnsi: boolean,
): number {
  let skippedChars = 0;
  const size = 10;
  const lineHeight = size * 1.35;
  const maxWidth = result.pageWidth - 40;
  const lines: string[] = [];
  for (const rawLine of text.split(/\n/)) {
    let line = rawLine.trim();
    if (safeForWinAnsi) {
      const cleaned = line.replace(LATIN_FALLBACK, '');
      skippedChars += line.length - cleaned.length;
      line = cleaned;
    }
    if (!line) continue;
    let current = '';
    for (const char of line) {
      const candidate = current + char;
      try {
        if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
          lines.push(current);
          current = char;
        } else {
          current = candidate;
        }
      } catch {
        skippedChars += 1;
      }
    }
    if (current) lines.push(current);
  }

  let y = result.pageHeight - 20;
  for (const line of lines) {
    if (y < 10) break;
    page.drawText(line, { x: 20, y, size, font, color: rgb(0, 0, 0), opacity: 0 });
    y -= lineHeight;
  }
  return skippedChars;
}

/**
 * Take the original (scanned) PDF and add an invisible text layer built from
 * OCR line boxes. The page image is untouched, so the output looks identical
 * but becomes selectable/searchable.
 */
export async function buildTextPdf(options: BuildTextPdfOptions): Promise<BuildTextPdfResult> {
  const threshold = options.threshold ?? DEFAULT_HIGH_CONFIDENCE_THRESHOLD;
  const pdfDoc = await PDFDocument.load(options.originalBytes);
  pdfDoc.registerFontkit(fontkit);

  const cjkBytes = await tryLoadCjkFont();
  let font: PDFFont;
  let usedCjkFont = false;
  if (cjkBytes) {
    font = await pdfDoc.embedFont(cjkBytes, { subset: true });
    usedCjkFont = true;
  } else {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  }

  const warnings: string[] = [];
  if (!usedCjkFont) {
    warnings.push(
      '未找到可嵌入的中文字体资产（public/fonts/NotoSansSC-*.ttf），本次导出的文字层会忽略非拉丁字符；' +
        'V4-relativity.pdf 等英文文档不受影响。',
    );
  }

  const pages = pdfDoc.getPages();
  const skippedPages: number[] = [];
  let textPages = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let skippedChars = 0;

  for (let index = 0; index < options.results.length; index += 1) {
    const result = options.results[index];
    const pageIndex = result.page - 1;
    if (pageIndex < 0 || pageIndex >= pages.length) continue;
    confidenceSum += result.confidence;
    confidenceCount += 1;

    const accuracy = evaluatePageAccuracy(result, threshold);
    const include = options.mode === 'all' || accuracy.highAccuracy;
    if (!include) {
      skippedPages.push(result.page);
      continue;
    }

    const page = pages[pageIndex];
    const edited = options.editedText?.get(result.page);
    if (edited !== undefined && edited.trim() !== result.ocrText.trim()) {
      skippedChars += drawEditedText(page, result, edited, font, !usedCjkFont);
    } else {
      skippedChars += drawOcrLines(page, result, font, !usedCjkFont);
    }
    textPages += 1;
    options.onProgress?.(index + 1, options.results.length);
  }

  if (skippedChars > 0) {
    warnings.push(`有 ${skippedChars} 个字符无法用当前字体写入文字层，已跳过。`);
  }

  const bytes = await pdfDoc.save({ useObjectStreams: true });
  return {
    bytes,
    totalPages: pages.length,
    textPages,
    skippedPages,
    averageConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
    usedCjkFont,
    warnings,
  };
}

export function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
