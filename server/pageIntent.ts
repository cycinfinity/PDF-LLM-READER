/**
 * Question intent parsing for page- and chapter-focused questions.
 *
 * This module is deliberately dependency-free and side-effect free so it can
 * be unit tested in Node and reused by the retrieval layer. It only parses the
 * user's question; it never looks at the document.
 */

export const MAX_FOCUS_PAGES = 20;

export interface PageRange {
  start: number;
  end: number;
}

export interface PageIntent {
  kind: 'pages';
  /** Valid, sorted, de-duplicated target pages (clamped to pageCount when known). */
  pages: number[];
  /** Pages exactly as parsed from the question, including out-of-range ones. */
  requestedPages: number[];
  /** Explicit ranges from the question, e.g. 第18-20页 -> [{start:18,end:20}]. */
  ranges: PageRange[];
  outOfRangePages: number[];
  truncatedFocus: boolean;
  raw: string;
}

export interface ChapterIntent {
  kind: 'chapter';
  label: string;
  number?: string;
  titleHint?: string;
  raw: string;
}

export type QuestionIntent = PageIntent | ChapterIntent;

export interface ParseIntentOptions {
  pageCount?: number;
  maxFocusPages?: number;
}

const CHINESE_NUMBER_CHARS = '零〇一二两三四五六七八九十百';
const NUMBER_TOKEN = `(?:\\d{1,4}|[${CHINESE_NUMBER_CHARS}]{1,6})`;

const PAGE_UNIT = '[页頁]';

const CHINESE_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** Parse "18", "十八", "二十", "一百零八", "两百" etc. */
export function parseChineseNumber(value: string): number | null {
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (!text || !new RegExp(`^[${CHINESE_NUMBER_CHARS}]+$`).test(text)) return null;

  let total = 0;
  let section = 0;
  let current = 0;

  for (const char of text) {
    if (char in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[char]!;
      continue;
    }
    if (char === '十') {
      section += (current || 1) * 10;
      current = 0;
      continue;
    }
    if (char === '百') {
      section += (current || 1) * 100;
      current = 0;
      continue;
    }
    return null;
  }

  total = section + current;
  return total > 0 ? total : null;
}

function parsePageNumber(token: string): number | null {
  const trimmed = token.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return parseChineseNumber(trimmed);
}

interface CollectedMatch {
  start: number;
  end: number;
  pages: number[];
  range?: PageRange;
  raw: string;
}

function overlapsAny(start: number, end: number, spans: Array<{ start: number; end: number }>): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function numberListToPages(value: string): number[] {
  const parts = value.split(/[、,，和及]/);
  const pages: number[] = [];
  for (const part of parts) {
    const page = parsePageNumber(part);
    if (page !== null) pages.push(page);
  }
  return pages;
}

function expandRange(start: number, end: number): number[] {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const pages: number[] = [];
  // Defensive cap: a malformed "第1-999999页" should never allocate huge arrays.
  for (let page = low; page <= Math.min(high, low + 500); page += 1) pages.push(page);
  return pages;
}

/**
 * Parse explicit page references from a question.
 * Supported examples:
 *   第18页 / 第十八页 / page 18 / p.18
 *   第18-20页 / 第18至20页 / pages 18-20 / pp. 18-20
 *   第18、19页 / pages 18, 19 and 20
 */
export function parsePageIntent(question: string, options: ParseIntentOptions = {}): PageIntent | null {
  const text = question.normalize('NFKC');
  const matches: CollectedMatch[] = [];
  const usedSpans: Array<{ start: number; end: number }> = [];

  const addMatch = (match: CollectedMatch) => {
    if (overlapsAny(match.start, match.end, usedSpans)) return;
    usedSpans.push({ start: match.start, end: match.end });
    matches.push(match);
  };

  // 1. Explicit ranges with a page unit on at least the right-hand side.
  const cnRange = new RegExp(
    `第?\\s*(${NUMBER_TOKEN})\\s*${PAGE_UNIT}?\\s*(?:-|–|—|~|～|至|到)\\s*第?\\s*(${NUMBER_TOKEN})\\s*${PAGE_UNIT}`,
    'g',
  );
  for (let match = cnRange.exec(text); match; match = cnRange.exec(text)) {
    const start = parsePageNumber(match[1]!);
    const end = parsePageNumber(match[2]!);
    if (start === null || end === null) continue;
    addMatch({
      start: match.index,
      end: match.index + match[0].length,
      pages: expandRange(start, end),
      range: { start: Math.min(start, end), end: Math.max(start, end) },
      raw: match[0],
    });
  }

  const enRange = /\b(?:pages?|pp?\.?)\s*(\d{1,4})\s*(?:-|–|—|~|to|through)\s*(\d{1,4})\b/gi;
  for (let match = enRange.exec(text); match; match = enRange.exec(text)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    addMatch({
      start: match.index,
      end: match.index + match[0].length,
      pages: expandRange(start, end),
      range: { start: Math.min(start, end), end: Math.max(start, end) },
      raw: match[0],
    });
  }

  // 2. Chinese page lists: 第18、19、20页 / 第18和19页.
  const cnList = new RegExp(
    `第?\\s*((?:${NUMBER_TOKEN})(?:\\s*[、,，和及]\\s*(?:${NUMBER_TOKEN}))+)\\s*${PAGE_UNIT}`,
    'g',
  );
  for (let match = cnList.exec(text); match; match = cnList.exec(text)) {
    const pages = numberListToPages(match[1]!);
    if (pages.length === 0) continue;
    addMatch({
      start: match.index,
      end: match.index + match[0].length,
      pages: [...new Set(pages)].sort((a, b) => a - b),
      raw: match[0],
    });
  }

  // 2b. English page lists: pages 18, 19 and 20 / pp. 18/19.
  const enList = /\b(?:pages?|pp?\.?)\s*(\d{1,4}(?:\s*(?:,|\/|&|\band\b)\s*\d{1,4})+)/gi;
  for (let match = enList.exec(text); match; match = enList.exec(text)) {
    const pages = match[1]!
      .split(/\s*(?:,|\/|&|\band\b)\s*/i)
      .map((part) => Number(part.trim()))
      .filter((page) => Number.isFinite(page) && page > 0);
    if (pages.length === 0) continue;
    addMatch({
      start: match.index,
      end: match.index + match[0].length,
      pages: [...new Set(pages)].sort((a, b) => a - b),
      raw: match[0],
    });
  }

  // 3. Single Chinese pages: 第18页 / 第十八頁.
  const cnSingle = new RegExp(`第\\s*(${NUMBER_TOKEN})\\s*${PAGE_UNIT}`, 'g');
  for (let match = cnSingle.exec(text); match; match = cnSingle.exec(text)) {
    const page = parsePageNumber(match[1]!);
    if (page === null) continue;
    addMatch({
      start: match.index,
      end: match.index + match[0].length,
      pages: [page],
      raw: match[0],
    });
  }

  // 4. English single pages: page 18 / p.18 / p 18.
  const enSingle = /\b(?:page|p)\s*\.?\s*(\d{1,4})\b/gi;
  for (let match = enSingle.exec(text); match; match = enSingle.exec(text)) {
    addMatch({
      start: match.index,
      end: match.index + match[0].length,
      pages: [Number(match[1])],
      raw: match[0],
    });
  }

  if (matches.length === 0) return null;

  const requestedPages = [
    ...new Set(matches.flatMap((match) => match.pages).filter((page) => Number.isFinite(page) && page > 0)),
  ].sort((a, b) => a - b);

  const pageCount = options.pageCount;
  const allPages = pageCount !== undefined && pageCount > 0
    ? requestedPages.filter((page) => page <= pageCount)
    : requestedPages;
  const outOfRangePages = pageCount !== undefined && pageCount > 0
    ? requestedPages.filter((page) => page > pageCount)
    : [];

  const maxFocusPages = Math.max(1, options.maxFocusPages ?? MAX_FOCUS_PAGES);
  const truncatedFocus = allPages.length > maxFocusPages;
  const pages = truncatedFocus ? allPages.slice(0, maxFocusPages) : allPages;

  const ranges: PageRange[] = [];
  for (const match of matches) {
    if (match.range) ranges.push(match.range);
  }

  return {
    kind: 'pages',
    pages,
    requestedPages,
    ranges,
    outOfRangePages,
    truncatedFocus,
    raw: matches.map((match) => match.raw).join(' / '),
  };
}

/**
 * Parse chapter/section references.
 * Supported examples: 第18章, 第18节, Chapter 12, Section 2.3, §2.3.
 */
export function parseChapterIntent(question: string): ChapterIntent | null {
  const text = question.normalize('NFKC');

  const cnMatch = new RegExp(`第\\s*(${NUMBER_TOKEN})\\s*([章節节])`).exec(text);
  if (cnMatch) {
    const number = String(parsePageNumber(cnMatch[1]!) ?? cnMatch[1]!.trim());
    const end = cnMatch.index + cnMatch[0].length;
    const after = text.slice(end, end + 40);
    const hint = after.match(/^[\s：:、\-—]+([^\s，。！？；,.!?:：\n]{2,20})/)?.[1];
    return {
      kind: 'chapter',
      label: cnMatch[0].replace(/\s+/g, ''),
      number,
      titleHint: hint && !/^(的|内容|讲|是|有|和|与)/.test(hint) ? hint : undefined,
      raw: cnMatch[0],
    };
  }

  const enMatch = /\b(?:chapter|section|chap\.?|§)\s*(\d{1,3}(?:\.\d+)*)\b/i.exec(text);
  if (enMatch) {
    const keyword = enMatch[0].replace(/\s+/g, ' ').trim();
    return {
      kind: 'chapter',
      label: keyword,
      number: enMatch[1],
      raw: enMatch[0],
    };
  }

  return null;
}

/** Page intents take precedence over chapter intents by design. */
export function parseQuestionIntent(question: string, options: ParseIntentOptions = {}): QuestionIntent | null {
  return parsePageIntent(question, options) ?? parseChapterIntent(question);
}
