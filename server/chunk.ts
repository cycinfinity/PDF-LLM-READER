export interface PageText {
  page: number;
  text: string;
}

export interface TextChunk {
  id: number;
  text: string;
  pageStart: number;
  pageEnd: number;
}

export interface ChunkOptions {
  chunkSize?: number;
  overlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 1000;
export const DEFAULT_CHUNK_OVERLAP = 150;

const PAGE_NUMBER_LINE =
  /^(?:[-–—]\s*)?(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?(?:\s*[-–—])?$/i;

const SENTENCE_END = /[。！？.!?;；:：]\s*$/;

/** NFKC-normalize, unify whitespace, and trim each page. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function lineKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/^\s*(?:page\s*)?\d+\s*(?:of|\/)\s*\d+\s*$/i, '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remove obvious page-number lines and repeated running headers/footers.
 * A repeated line is only removed when it sits in the first/last three lines of
 * the page, so repeated body sentences are preserved.
 */
export function cleanPages(pages: PageText[]): PageText[] {
  const normalized = pages
    .map((page) => ({ page: page.page, text: normalizeText(page.text) }))
    .sort((a, b) => a.page - b.page);

  if (normalized.length === 0) return [];

  const lineCounts = new Map<string, Set<number>>();
  for (const page of normalized) {
    for (const line of page.text.split('\n')) {
      const key = lineKey(line);
      if (!key || key.length > 80) continue;
      let set = lineCounts.get(key);
      if (!set) {
        set = new Set<number>();
        lineCounts.set(key, set);
      }
      set.add(page.page);
    }
  }

  const threshold = Math.max(3, Math.ceil(normalized.length * 0.5));
  const repeated = new Set<string>();
  if (normalized.length >= 5) {
    for (const [key, pageSet] of lineCounts) {
      if (key.length >= 2 && pageSet.size >= threshold) repeated.add(key);
    }
  }

  return normalized.map((page) => {
    const lines = page.text.split('\n');
    const nonEmpty = lines
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.trim().length > 0);
    const edgeIndexes = new Set<number>();
    for (const entry of nonEmpty.slice(0, 3)) edgeIndexes.add(entry.index);
    for (const entry of nonEmpty.slice(-3)) edgeIndexes.add(entry.index);

    const kept = lines.filter((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (PAGE_NUMBER_LINE.test(trimmed)) return false;
      const key = lineKey(trimmed);
      // A repeated line at a page edge is a running header/footer only when it
      // does not look like a real sentence; body lines often share a template
      // (e.g. "第N页……。") and must be preserved.
      if (repeated.has(key) && edgeIndexes.has(index) && !SENTENCE_END.test(trimmed)) {
        return false;
      }
      return true;
    });

    return { page: page.page, text: normalizeText(kept.join('\n')) };
  });
}

interface PageRange {
  page: number;
  start: number;
  end: number;
}

function pageAtOffset(ranges: PageRange[], offset: number): number {
  if (ranges.length === 0) return 1;
  let lo = 0;
  let hi = ranges.length - 1;
  let page = ranges[0]!.page;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid]!;
    if (offset < range.start) {
      hi = mid - 1;
    } else {
      page = range.page;
      lo = mid + 1;
    }
  }
  return page;
}

function findSplitBoundary(text: string, from: number, to: number): number | undefined {
  // Prefer a paragraph break.
  for (let i = to; i >= from; i -= 1) {
    if (text[i] === '\n' && text[i + 1] === '\n') return i;
  }
  // Then a sentence boundary (also works for CJK, which has no trailing space).
  for (let i = to; i >= from; i -= 1) {
    const char = text[i]!;
    if (/[。！？!?.;；]/.test(char)) {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next) || /[\u3000-\u9fff]/.test(next)) return i + 1;
    }
  }
  // Finally a whitespace boundary.
  for (let i = to; i >= from; i -= 1) {
    if (/\s/.test(text[i]!)) return i;
  }
  return undefined;
}

/**
 * Build page-attributed chunks from page texts.
 *
 * The pages are concatenated with a page map, then split at paragraph/sentence
 * boundaries near the target size. Chunk boundaries are mapped back to the PDF
 * page range so answers can cite real page numbers.
 */
export function buildChunks(pages: PageText[], options: ChunkOptions = {}): TextChunk[] {
  const chunkSize = Math.max(200, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(options.overlap ?? DEFAULT_CHUNK_OVERLAP, chunkSize - 1));

  const cleaned = cleanPages(pages);
  const ranges: PageRange[] = [];
  let combined = '';

  for (const page of cleaned) {
    const text = page.text.trim();
    if (!text) {
      ranges.push({ page: page.page, start: combined.length, end: combined.length });
      continue;
    }
    if (combined.length > 0) combined += '\n\n';
    const start = combined.length;
    combined += text;
    ranges.push({ page: page.page, start, end: combined.length });
  }

  const chunks: TextChunk[] = [];
  let cursor = 0;

  while (cursor < combined.length) {
    // Skip separators at the beginning of a chunk.
    while (cursor < combined.length && /\s/.test(combined[cursor]!)) cursor += 1;
    if (cursor >= combined.length) break;

    const hardEnd = Math.min(cursor + chunkSize, combined.length);
    let end = hardEnd;
    if (hardEnd < combined.length) {
      const minBoundary = cursor + Math.floor(chunkSize * 0.55);
      end = findSplitBoundary(combined, minBoundary, hardEnd) ?? hardEnd;
      if (end <= cursor) end = hardEnd;
    }

    const raw = combined.slice(cursor, end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text.length > 0) {
      const startOffset = cursor + leading;
      chunks.push({
        id: chunks.length,
        text,
        pageStart: pageAtOffset(ranges, startOffset),
        pageEnd: pageAtOffset(ranges, Math.max(startOffset, startOffset + text.length - 1)),
      });
    }

    if (end >= combined.length) break;
    const nextCursor = end - overlap;
    cursor = nextCursor > cursor ? nextCursor : end;
  }

  return chunks;
}

export interface CorpusStats {
  charCount: number;
  pageCount: number;
  chunkCount: number;
  emptyPageCount: number;
}

export function corpusStats(pages: PageText[], chunks: TextChunk[]): CorpusStats {
  return {
    charCount: pages.reduce((sum, page) => sum + page.text.trim().length, 0),
    pageCount: pages.length,
    chunkCount: chunks.length,
    emptyPageCount: pages.filter((page) => page.text.trim().length === 0).length,
  };
}
