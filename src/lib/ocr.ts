import { createWorker, type Worker } from 'tesseract.js';
import type { PDFDocumentProxy } from './pdf';

export type OcrLanguage = 'eng' | 'chi_sim' | 'eng+chi_sim';

export const OCR_LANGUAGES: Array<{ value: OcrLanguage; label: string }> = [
  { value: 'eng', label: 'English' },
  { value: 'chi_sim', label: '简体中文' },
  { value: 'eng+chi_sim', label: '中英混排' },
];

export interface OcrBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  confidence: number;
  bbox: OcrBbox;
}

export interface OcrLine {
  text: string;
  confidence: number;
  bbox: OcrBbox;
  /**
   * Tesseract word boxes. Optional for backwards compatibility with cached
   * results; the text-PDF layer falls back to a single line box when absent.
   */
  words?: OcrWord[];
}

export interface OcrPageResult {
  page: number;
  /** OCR text before any manual edits. */
  ocrText: string;
  confidence: number;
  lines: OcrLine[];
  canvasWidth: number;
  canvasHeight: number;
  /** PDF page size in points (1/72 inch). */
  pageWidth: number;
  pageHeight: number;
  language: OcrLanguage;
  durationMs: number;
}

export type OcrStage = 'rendering' | 'recognizing';

export interface OcrProgress {
  stage: OcrStage;
  /** 0..1 within the current stage. */
  progress: number;
}

const assetBase = import.meta.env.BASE_URL.replace(/\/$/, '');

const OCR_ASSETS = {
  workerPath: `${assetBase}/ocr/worker.min.js`,
  corePath: `${assetBase}/ocr/core`,
  langPath: `${assetBase}/ocr/lang`,
};

interface ActiveWorker {
  worker: Worker;
  language: OcrLanguage;
}

let activeWorker: ActiveWorker | null = null;
let workerPromise: Promise<ActiveWorker> | null = null;

function getWorker(
  language: OcrLanguage,
  logger: (message: { status: string; progress: number }) => void,
): Promise<ActiveWorker> {
  if (activeWorker?.language === language) return Promise.resolve(activeWorker);
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    if (activeWorker) {
      await activeWorker.worker.terminate();
      activeWorker = null;
    }
    const worker = await createWorker(language, 1, {
      workerPath: OCR_ASSETS.workerPath,
      corePath: OCR_ASSETS.corePath,
      langPath: OCR_ASSETS.langPath,
      cacheMethod: 'none',
      gzip: true,
      logger: (message) => logger(message),
    });
    activeWorker = { worker, language };
    return activeWorker;
  })().finally(() => {
    workerPromise = null;
  });

  return workerPromise;
}

export async function disposeOcrWorker(): Promise<void> {
  const current = activeWorker;
  activeWorker = null;
  workerPromise = null;
  if (current) await current.worker.terminate();
}

interface RenderForOcrResult {
  canvas: HTMLCanvasElement;
  pageWidth: number;
  pageHeight: number;
  scale: number;
}

const OCR_TARGET_WIDTH = 1600;
// A tesseract.js worker can die silently under memory pressure; without a
// timeout its recognize() promise never settles and a batch export hangs
// forever. Time out, reset the worker, and let the caller retry.
const OCR_RECOGNIZE_TIMEOUT_MS = 120_000;

async function renderPageForOcr(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
): Promise<RenderForOcrResult> {
  const page = await pdfDoc.getPage(pageNumber);
  try {
    const baseViewport = page.getViewport({ scale: 1 });
    // Large scan pages can be 3400+ PDF points wide; forcing a 1.5x minimum
    // would allocate a >100 MB canvas per page and can exhaust the renderer
    // during full-book conversion. Target ~2200 px instead, with a sane range.
    const scale = Math.min(3, Math.max(0.4, OCR_TARGET_WIDTH / baseViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));

    const task = page.render({ canvas, viewport });
    await task.promise;

    return {
      canvas,
      pageWidth: baseViewport.width,
      pageHeight: baseViewport.height,
      scale,
    };
  } finally {
    page.cleanup();
  }
}

interface TesseractWordLike {
  text?: string;
  confidence?: number;
  bbox?: OcrBbox;
}

interface TesseractLineLike {
  text?: string;
  confidence?: number;
  bbox?: OcrBbox;
  words?: TesseractWordLike[];
}

interface TesseractParagraphLike {
  lines?: TesseractLineLike[];
}

interface TesseractBlockLike {
  paragraphs?: TesseractParagraphLike[];
}

function extractLines(blocks: TesseractBlockLike[] | null | undefined): OcrLine[] {
  const lines: OcrLine[] = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = (line.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text || !line.bbox) continue;
        const words: OcrWord[] = [];
        for (const word of line.words ?? []) {
          const wordText = (word.text ?? '').trim();
          if (!wordText || !word.bbox) continue;
          words.push({
            text: wordText,
            confidence: typeof word.confidence === 'number' ? word.confidence : 0,
            bbox: word.bbox,
          });
        }
        lines.push({
          text,
          confidence: typeof line.confidence === 'number' ? line.confidence : 0,
          bbox: line.bbox,
          words: words.length > 0 ? words : undefined,
        });
      }
    }
  }
  return lines;
}

/**
 * Render one PDF page and run Tesseract on it. Reuses a single worker per
 * language so repeated pages don't pay the WASM/traineddata startup cost.
 */
export async function ocrPdfPage(
  pdfDoc: PDFDocumentProxy,
  pageNumber: number,
  language: OcrLanguage,
  onProgress?: (progress: OcrProgress) => void,
): Promise<OcrPageResult> {
  const startedAt = Date.now();
  onProgress?.({ stage: 'rendering', progress: 0 });
  const rendered = await renderPageForOcr(pdfDoc, pageNumber);

  onProgress?.({ stage: 'recognizing', progress: 0 });
  const active = await getWorker(language, (message) => {
    if (message.status === 'recognizing text') {
      onProgress?.({ stage: 'recognizing', progress: Math.max(0, Math.min(1, message.progress)) });
    }
  });

  const canvasWidth = rendered.canvas.width;
  const canvasHeight = rendered.canvas.height;
  let recognized: Awaited<ReturnType<Worker['recognize']>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    recognized = await Promise.race([
      active.worker.recognize(rendered.canvas, {}, { text: true, blocks: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              'OCR 识别超时（可能是识别进程内存不足）。已重置识别进程，请重新识别当前页。',
            ),
          );
        }, OCR_RECOGNIZE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    await disposeOcrWorker().catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    // Release the canvas backing store promptly; a full-book conversion keeps
    // hundreds of pages in flight and renderer memory is the limiting factor.
    rendered.canvas.width = 0;
    rendered.canvas.height = 0;
  }
  const data = recognized.data;
  const lines = extractLines(data.blocks as TesseractBlockLike[] | null | undefined);
  const text = (data.text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    page: pageNumber,
    ocrText: text,
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    lines,
    canvasWidth,
    canvasHeight,
    pageWidth: rendered.pageWidth,
    pageHeight: rendered.pageHeight,
    language,
    durationMs: Date.now() - startedAt,
  };
}

export {
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
  evaluatePageAccuracy,
  type PageAccuracy,
} from './ocrAccuracy';
