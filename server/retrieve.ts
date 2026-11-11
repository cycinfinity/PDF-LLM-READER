import type { TextChunk } from './chunk';
import { MAX_FOCUS_PAGES, parseQuestionIntent, type QuestionIntent } from './pageIntent';

export type RetrievalMode = 'full' | 'retrieval' | 'summary' | 'pages' | 'chapter';

export interface RetrievalOptions {
  topK: number;
  contextChars: number;
  /** Total page count of the document; used to clamp page references. */
  pageCount?: number;
}

export interface RetrievalResult {
  mode: RetrievalMode;
  chunks: TextChunk[];
  contextChars: number;
  pages: number[];
  totalChunks: number;
  /** Pages explicitly requested by the question (including out-of-range ones). */
  requestedPages?: number[];
  /** Chapter/section label explicitly requested by the question. */
  requestedChapter?: string;
  /** Human-readable explanation of fallbacks/truncation for the UI. */
  note?: string;
}

const PAGE_MODE_MAX_CONTEXT_CHARS = 24000;
const NEIGHBOR_PAGES = 1;
const CHAPTER_MAX_CHUNKS = 8;

interface RetrievalIndex {
  chunks: TextChunk[];
  docFreq: Map<string, number>;
  idf: Map<string, number>;
  termFreq: Map<string, number>[];
  length: number[];
}

const ENGLISH_STOPWORDS = new Set(
  [
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do', 'does',
    'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'me',
    'might', 'more', 'most', 'must', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'shall', 'should', 'so',
    'some', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
    'those', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will',
    'with', 'would', 'you', 'your', 'about', 'also', 'any', 'because', 'between', 'both', 'each', 'has',
    'just', 'only', 'other', 'over', 'same', 'through', 'under', 'very', 'well', '给出', '如下',
  ].filter(Boolean),
);

const CJK_STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '一个', '可以', '因为', '所以', '但是', '如果', '以及',
  '什么', '怎么', '如何', '是否', '哪些', '其中', '这一', '这些', '那些', '已经', '还是', '就是',
  '没有', '不是', '进行', '通过', '对于', '关于', '由于', '并且', '或者', '然后', '而且', '因此',
]);

/**
 * Tokenize mixed English/CJK text. Latin text becomes words; CJK runs become
 * overlapping bigrams (a cheap, dependency-free approximation of Chinese terms).
 */
export function tokenize(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const tokens: string[] = [];

  const latin = normalized.match(/[a-z0-9][a-z0-9_'-]*/g) ?? [];
  for (const token of latin) {
    if (token.length < 2 && !/^\d$/.test(token)) continue;
    if (ENGLISH_STOPWORDS.has(token)) continue;
    tokens.push(token);
  }

  const cjkRuns = normalized.match(/[\u3400-\u4dbf\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!CJK_STOP_BIGRAMS.has(bigram)) tokens.push(bigram);
    }
  }

  return tokens.filter((token) => token.trim().length > 0);
}

function chunkTokens(chunks: TextChunk[]): string[][] {
  return chunks.map((chunk) => tokenize(chunk.text));
}

export function buildIndex(chunks: TextChunk[]): RetrievalIndex {
  const tokensPerChunk = chunkTokens(chunks);
  const docFreq = new Map<string, number>();
  const termFreq: Map<string, number>[] = [];
  const length: number[] = [];

  for (const tokens of tokensPerChunk) {
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    for (const token of freq.keys()) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
    termFreq.push(freq);
    length.push(tokens.length);
  }

  const total = chunks.length;
  const idf = new Map<string, number>();
  for (const [token, df] of docFreq) {
    idf.set(token, Math.log((total + 1) / (df + 1)) + 1);
  }

  return { chunks, docFreq, idf, termFreq, length };
}

function uniquePages(chunks: TextChunk[]): number[] {
  const pages = new Set<number>();
  for (const chunk of chunks) {
    for (let page = chunk.pageStart; page <= chunk.pageEnd; page += 1) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Detect questions whose answer requires broad coverage rather than a pinpoint hit. */
export function isSummaryQuestion(question: string): boolean {
  return /总结|概括|摘要|主要(内容|观点|结论|讲)|讲(了|什么)|说(了|什么)|全文|整篇|全书|summary|summarize|overview|main (idea|point|topic)|what is this (document|paper|book) about/i.test(
    question,
  );
}

function selectSummaryChunks(index: RetrievalIndex, budget: number): TextChunk[] {
  const chunks = index.chunks;
  if (chunks.length === 0) return [];

  const selected = new Map<number, TextChunk>();
  const add = (chunk: TextChunk) => {
    if (selected.size >= 24) return;
    const current = [...selected.values()].reduce((sum, item) => sum + item.text.length + 16, 0);
    if (current + chunk.text.length + 16 > budget && selected.size > 0) return;
    selected.set(chunk.id, chunk);
  };

  // Beginning, end, and evenly spaced middle samples.
  for (const chunk of chunks.slice(0, 2)) add(chunk);
  for (const chunk of chunks.slice(-2)) add(chunk);
  const sampleCount = Math.min(24, Math.max(4, chunks.length));
  for (let i = 0; i < sampleCount; i += 1) {
    const position = Math.floor((i / sampleCount) * (chunks.length - 1));
    add(chunks[position]!);
  }

  return [...selected.values()].sort((a, b) => a.id - b.id);
}

function selectByBudget(
  candidates: Array<{ chunk: TextChunk; score: number }>,
  budget: number,
  minimumCount: number,
): TextChunk[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
  const selected = new Map<number, TextChunk>();
  let used = 0;

  for (const candidate of sorted) {
    const cost = candidate.chunk.text.length + 16;
    if (used + cost > budget && selected.size >= minimumCount) continue;
    if (used + cost > budget && selected.size > 0) continue;
    selected.set(candidate.chunk.id, candidate.chunk);
    used += cost;
  }

  return [...selected.values()].sort((a, b) => a.pageStart - b.pageStart || a.id - b.id);
}

function chunkOverlapsPages(chunk: TextChunk, pages: Set<number>): boolean {
  for (let page = chunk.pageStart; page <= chunk.pageEnd; page += 1) {
    if (pages.has(page)) return true;
  }
  return false;
}

function sortChunks(chunks: TextChunk[]): TextChunk[] {
  return [...chunks].sort(
    (a, b) => a.pageStart - b.pageStart || a.pageEnd - b.pageEnd || a.id - b.id,
  );
}

/**
 * Select the chunks that cover the requested pages, with a small neighbour
 * window. Target page chunks are inserted before neighbour chunks so a tight
 * budget can never drop the page the user asked about in favour of context.
 */
function selectPageChunks(
  chunks: TextChunk[],
  pages: number[],
  baseBudget: number,
): { chunks: TextChunk[]; note?: string } {
  const pageSet = new Set(pages);
  const neighbourPages = new Set<number>();
  for (const page of pages) {
    for (let delta = -NEIGHBOR_PAGES; delta <= NEIGHBOR_PAGES; delta += 1) {
      const neighbour = page + delta;
      if (neighbour >= 1 && !pageSet.has(neighbour)) neighbourPages.add(neighbour);
    }
  }

  const targetChunks = sortChunks(chunks.filter((chunk) => chunkOverlapsPages(chunk, pageSet)));
  const targetIds = new Set(targetChunks.map((chunk) => chunk.id));
  const neighbourChunks = sortChunks(
    chunks.filter((chunk) => !targetIds.has(chunk.id) && chunkOverlapsPages(chunk, neighbourPages)),
  );

  const targetChars = targetChunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const neighbourChars = neighbourChunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const pageBudget = Math.min(
    PAGE_MODE_MAX_CONTEXT_CHARS,
    Math.max(baseBudget, targetChars + neighbourChars),
  );

  const selected = new Map<number, TextChunk>();
  let used = 0;
  let targetTruncated = false;

  for (const chunk of targetChunks) {
    const cost = chunk.text.length + 16;
    // Always keep the first target chunk, even if a single chunk is larger
    // than the configured budget; otherwise the question would get no page text.
    if (selected.size === 0 || used + cost <= pageBudget) {
      selected.set(chunk.id, chunk);
      used += cost;
    } else {
      targetTruncated = true;
      break;
    }
  }

  let neighboursTruncated = false;
  for (const chunk of neighbourChunks) {
    const cost = chunk.text.length + 16;
    if (used + cost > pageBudget) {
      neighboursTruncated = true;
      break;
    }
    selected.set(chunk.id, chunk);
    used += cost;
  }

  const notes: string[] = [];
  if (targetTruncated) notes.push('目标页文本超出单次上下文预算，已按页序截断');
  if (neighboursTruncated) notes.push('邻页上下文已按预算截断');

  return {
    chunks: sortChunks([...selected.values()]),
    note: notes.length > 0 ? notes.join('；') : undefined,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function chapterHeadingPatterns(intent: { number?: string; label: string }): RegExp[] {
  const patterns: RegExp[] = [];
  if (intent.number) {
    const number = escapeRegExp(intent.number);
    patterns.push(new RegExp(`第\\s*${number}\\s*[章節节]`));
    patterns.push(new RegExp(`\\bchapter\\s+${number}\\b`, 'i'));
    patterns.push(new RegExp(`\\bsection\\s+${number}\\b`, 'i'));
  }
  if (intent.label) patterns.push(new RegExp(escapeRegExp(intent.label), 'i'));
  return patterns;
}

function selectChapterChunks(
  chunks: TextChunk[],
  intent: { number?: string; label: string },
  budget: number,
): TextChunk[] | null {
  const patterns = chapterHeadingPatterns(intent);
  const startIndex = chunks.findIndex((chunk) => patterns.some((pattern) => pattern.test(chunk.text)));
  if (startIndex < 0) return null;

  const nextHeading = /(?:^|\n)\s*(?:第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*[章節节]|chapter\s+\d+|section\s+\d+)/i;
  const selected: TextChunk[] = [];
  let used = 0;

  for (let index = startIndex; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    if (index > startIndex && nextHeading.test(chunk.text) && !patterns.some((pattern) => pattern.test(chunk.text))) {
      break;
    }
    const cost = chunk.text.length + 16;
    if (selected.length > 0 && used + cost > budget) break;
    selected.push(chunk);
    used += cost;
    if (selected.length >= CHAPTER_MAX_CHUNKS) break;
  }

  return sortChunks(selected);
}

function selectLexicalChunks(
  index: RetrievalIndex,
  queryTokens: string[],
  topK: number,
  contextChars: number,
): { chunks: TextChunk[]; hasOverlap: boolean } {
  const scored: Array<{ chunk: TextChunk; score: number }> = [];
  for (let i = 0; i < index.chunks.length; i += 1) {
    const freq = index.termFreq[i]!;
    let score = 0;
    for (const token of queryTokens) {
      const termCount = freq.get(token);
      if (!termCount) continue;
      score += (1 + Math.log(termCount)) * (index.idf.get(token) ?? 0);
    }
    if (score > 0) {
      score /= Math.sqrt(index.length[i]! || 1);
      scored.push({ chunk: index.chunks[i]!, score });
    }
  }

  if (scored.length === 0) return { chunks: [], hasOverlap: false };

  scored.sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
  const primary = scored.slice(0, topK).map((entry) => entry.chunk);

  const expanded = new Map<number, { chunk: TextChunk; score: number }>();
  for (const entry of scored.slice(0, topK)) expanded.set(entry.chunk.id, entry);
  const scoresById = new Map(scored.map((entry) => [entry.chunk.id, entry.score]));
  for (const chunk of primary) {
    for (const neighborId of [chunk.id - 1, chunk.id + 1]) {
      if (neighborId < 0 || neighborId >= index.chunks.length) continue;
      if (expanded.has(neighborId)) continue;
      expanded.set(neighborId, {
        chunk: index.chunks[neighborId]!,
        score: (scoresById.get(neighborId) ?? 0) * 0.5,
      });
    }
  }

  const selected = selectByBudget([...expanded.values()], contextChars, Math.min(topK, 2));
  return { chunks: selected, hasOverlap: true };
}

export function retrieve(
  chunks: TextChunk[],
  question: string,
  options: RetrievalOptions,
): RetrievalResult {
  const topK = Math.max(1, Math.min(20, Math.round(options.topK)));
  const contextChars = Math.max(1000, Math.round(options.contextChars));
  const queryTokens = [...new Set(tokenize(question))];

  if (chunks.length === 0) {
    return { mode: 'retrieval', chunks: [], contextChars: 0, pages: [], totalChunks: 0 };
  }

  const intent: QuestionIntent | null = parseQuestionIntent(question, {
    pageCount: options.pageCount,
  });
  const meta: Pick<RetrievalResult, 'requestedPages' | 'requestedChapter' | 'note'> = {};
  const notes: string[] = [];

  const finish = (result: RetrievalResult): RetrievalResult => ({
    ...result,
    ...meta,
    ...(notes.length > 0 ? { note: notes.join('；') } : {}),
  });

  const selectionResult = (mode: RetrievalMode, selected: TextChunk[]): RetrievalResult => ({
    mode,
    chunks: selected,
    contextChars: selected.reduce((sum, chunk) => sum + chunk.text.length, 0),
    pages: uniquePages(selected),
    totalChunks: chunks.length,
  });

  if (intent?.kind === 'pages') {
    meta.requestedPages = intent.requestedPages.length > 0 ? intent.requestedPages : intent.pages;
    if (options.pageCount && intent.outOfRangePages.length > 0) {
      notes.push(
        `页码超出文档范围（1–${options.pageCount}）：${intent.outOfRangePages.join('、')}`,
      );
    }
    if (intent.truncatedFocus) {
      notes.push(`请求页数超过单次上限（${MAX_FOCUS_PAGES} 页），仅保留前 ${intent.pages.length} 页`);
    }

    if (intent.pages.length === 0) {
      notes.push('请求的页码不在文档范围内，已回退为普通检索');
    } else {
      const pageSelection = selectPageChunks(chunks, intent.pages, contextChars);
      if (pageSelection.note) notes.push(pageSelection.note);
      return finish(selectionResult('pages', pageSelection.chunks));
    }
  } else if (intent?.kind === 'chapter') {
    meta.requestedChapter = intent.label;
    const chapterSelection = selectChapterChunks(chunks, intent, contextChars);
    if (chapterSelection) {
      return finish(selectionResult('chapter', chapterSelection));
    }
    notes.push('未定位到章节标题，已回退为关键词检索');
  }

  const totalTextChars = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  if (totalTextChars <= contextChars) {
    return finish({
      mode: 'full',
      chunks,
      contextChars: totalTextChars,
      pages: uniquePages(chunks),
      totalChunks: chunks.length,
    });
  }

  const index = buildIndex(chunks);

  // A chapter question with no matching heading should still use keyword
  // retrieval rather than being treated as a broad summary question.
  if (isSummaryQuestion(question) && intent?.kind !== 'chapter') {
    const selected = selectSummaryChunks(index, contextChars);
    return finish(selectionResult('summary', selected));
  }

  const lexical = selectLexicalChunks(index, queryTokens, topK, contextChars);
  if (!lexical.hasOverlap) {
    const selected = selectSummaryChunks(index, contextChars).slice(0, Math.min(6, topK));
    return finish(selectionResult(intent?.kind === 'chapter' ? 'chapter' : 'summary', selected));
  }

  return finish(selectionResult(intent?.kind === 'chapter' ? 'chapter' : 'retrieval', lexical.chunks));
}
