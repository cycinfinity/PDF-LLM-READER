/**
 * Pure accuracy heuristics for OCR pages.
 *
 * Kept separate from `ocr.ts` so the rules can be unit tested in Node without
 * importing the browser-only Tesseract worker.
 */

export interface OcrAccuracyLine {
  text: string;
  confidence: number;
}

export interface PageAccuracy {
  meanConfidence: number;
  lowConfidenceRatio: number;
  charCount: number;
  highAccuracy: boolean;
}

export const DEFAULT_HIGH_CONFIDENCE_THRESHOLD = 80;

/** A line below this confidence is treated as clearly uncertain. */
export const LOW_CONFIDENCE_LINE = 60;

/** A page needs at least this many non-whitespace characters to be useful. */
export const MIN_USEFUL_CHARS = 20;

/** At most this share of lines may be clearly uncertain. */
export const MAX_LOW_CONFIDENCE_RATIO = 0.3;

/**
 * A page is "high accuracy" when its mean line confidence reaches `threshold`,
 * it has enough text to answer questions from, and at most 30% of its lines are
 * clearly uncertain. Rationale: V4 pages 1-2 scored 91/89, while noisy scans
 * or photos usually lose one of the three gates. See README for calibration.
 */
export function evaluatePageAccuracy(
  result: { lines: OcrAccuracyLine[]; ocrText: string },
  threshold = DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
): PageAccuracy {
  const lines = result.lines;
  const charCount = result.ocrText.replace(/\s/g, '').length;
  if (lines.length === 0) {
    return { meanConfidence: 0, lowConfidenceRatio: 1, charCount, highAccuracy: false };
  }

  const total = lines.reduce((sum, line) => sum + line.confidence, 0);
  const meanConfidence = total / lines.length;
  const low = lines.filter((line) => line.confidence < LOW_CONFIDENCE_LINE).length;
  const lowConfidenceRatio = low / lines.length;
  const highAccuracy =
    meanConfidence >= threshold &&
    charCount >= MIN_USEFUL_CHARS &&
    lowConfidenceRatio <= MAX_LOW_CONFIDENCE_RATIO;

  return { meanConfidence, lowConfidenceRatio, charCount, highAccuracy };
}
