import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
  evaluatePageAccuracy,
  type OcrAccuracyLine,
} from '../src/lib/ocrAccuracy';

function lines(...confidences: number[]): OcrAccuracyLine[] {
  return confidences.map((confidence) => ({ text: 'sample line', confidence }));
}

describe('evaluatePageAccuracy', () => {
  it('marks a clean, text-rich page as high accuracy', () => {
    const page = evaluatePageAccuracy({
      lines: lines(92, 90, 88, 91, 89),
      ocrText: 'Relativity is based on two postulates. '.repeat(4),
    });
    expect(page.highAccuracy).toBe(true);
    expect(page.meanConfidence).toBeCloseTo(90);
    expect(page.lowConfidenceRatio).toBe(0);
    expect(DEFAULT_HIGH_CONFIDENCE_THRESHOLD).toBe(80);
  });

  it('honours a custom threshold', () => {
    const page = { lines: lines(75, 75, 75), ocrText: 'x'.repeat(40) };
    expect(evaluatePageAccuracy(page).highAccuracy).toBe(false);
    expect(evaluatePageAccuracy(page, 70).highAccuracy).toBe(true);
  });

  it('rejects pages with too few useful characters', () => {
    const page = evaluatePageAccuracy({ lines: lines(95, 95), ocrText: 'abc' });
    expect(page.charCount).toBe(3);
    expect(page.highAccuracy).toBe(false);
  });

  it('rejects pages where too many lines are clearly uncertain', () => {
    // mean 73.3 clears a 60 threshold, chars are enough, but 2/6 = 33% of lines
    // are below 60, which is above the 30% cap.
    const page = evaluatePageAccuracy(
      { lines: lines(95, 95, 95, 95, 30, 30), ocrText: 'x'.repeat(60) },
      60,
    );
    expect(page.meanConfidence).toBeGreaterThan(60);
    expect(page.lowConfidenceRatio).toBeCloseTo(2 / 6);
    expect(page.highAccuracy).toBe(false);
  });

  it('rejects a page without recognized lines', () => {
    const page = evaluatePageAccuracy({ lines: [], ocrText: ' '.repeat(200) });
    expect(page.highAccuracy).toBe(false);
    expect(page.meanConfidence).toBe(0);
    expect(page.lowConfidenceRatio).toBe(1);
  });

  it('counts characters without whitespace', () => {
    const page = evaluatePageAccuracy({
      lines: lines(90),
      ocrText: '  a b \n c  ',
    });
    expect(page.charCount).toBe(3);
  });
});
