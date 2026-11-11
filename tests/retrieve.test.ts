import { describe, expect, it } from 'vitest';
import type { TextChunk } from '../server/chunk';
import { isSummaryQuestion, retrieve, tokenize } from '../server/retrieve';

function makeChunks(count: number, marker?: { index: number; token: string }): TextChunk[] {
  return Array.from({ length: count }, (_, index) => {
    const prefix = index === marker?.index ? `${marker.token} ` : '';
    return {
      id: index,
      pageStart: index + 1,
      pageEnd: index + 1,
      text: `${prefix}第 ${index + 1} 页内容。这是第 ${index + 1} 个片段。${'填充文字 '.repeat(60)}`,
    };
  });
}

describe('tokenize', () => {
  it('produces overlapping bigrams for CJK and keeps content words', () => {
    const tokens = tokenize('相对论的基本假设是什么？');
    expect(tokens).toContain('相对');
    expect(tokens).toContain('假设');
    expect(tokens).not.toContain('什么');
  });

  it('keeps latin words and drops English stopwords', () => {
    const tokens = tokenize('What is the principle of relativity?');
    expect(tokens).toContain('principle');
    expect(tokens).toContain('relativity');
    expect(tokens).not.toContain('what');
    expect(tokens).not.toContain('the');
  });
});

describe('isSummaryQuestion', () => {
  it('detects broad questions', () => {
    expect(isSummaryQuestion('总结第 1 页的内容')).toBe(true);
    expect(isSummaryQuestion('这份文档主要讲了什么？')).toBe(true);
    expect(isSummaryQuestion('summarize this paper')).toBe(true);
  });

  it('does not flag pinpoint questions', () => {
    expect(isSummaryQuestion('什么是惯性参考系？')).toBe(false);
    expect(isSummaryQuestion('第 3 页的公式是什么？')).toBe(false);
  });
});

describe('retrieve', () => {
  it('uses full context when the whole document fits the budget', () => {
    const chunks = makeChunks(2);
    const result = retrieve(chunks, '任意问题', { topK: 6, contextChars: 6000 });
    expect(result.mode).toBe('full');
    expect(result.chunks).toHaveLength(2);
    expect(result.pages).toEqual([1, 2]);
  });

  it('selects lexically relevant chunks and their pages', () => {
    const chunks = makeChunks(10, { index: 7, token: 'ZEBRA' });
    const result = retrieve(chunks, 'ZEBRA 是什么？', { topK: 3, contextChars: 1000 });

    expect(result.mode).toBe('retrieval');
    expect(result.chunks.some((chunk) => chunk.id === 7)).toBe(true);
    expect(result.pages).toContain(8);
    expect(result.contextChars).toBeGreaterThan(0);
    expect(result.contextChars).toBeLessThanOrEqual(1100);
  });

  it('samples beginning and end for summary questions', () => {
    const chunks = makeChunks(30);
    const result = retrieve(chunks, '总结全文', { topK: 6, contextChars: 1500 });

    expect(result.mode).toBe('summary');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.some((chunk) => chunk.id === 0)).toBe(true);
    expect(result.chunks.some((chunk) => chunk.id === 29)).toBe(true);
  });

  it('falls back to a spread sample when there is no lexical overlap', () => {
    const chunks = makeChunks(12);
    const result = retrieve(chunks, 'zzzz qqqq', { topK: 6, contextChars: 1200 });

    expect(result.mode).toBe('summary');
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.length).toBeLessThanOrEqual(6);
  });

  it('returns an empty retrieval for an empty document', () => {
    const result = retrieve([], '问题', { topK: 6, contextChars: 6000 });
    expect(result.chunks).toHaveLength(0);
    expect(result.pages).toHaveLength(0);
  });
});

describe('page and chapter intents', () => {
  it('prioritises the requested page over summary sampling', () => {
    const chunks = makeChunks(30);
    const result = retrieve(chunks, '第18页讲了什么内容？', {
      topK: 6,
      contextChars: 1200,
      pageCount: 30,
    });

    expect(result.mode).toBe('pages');
    expect(result.requestedPages).toEqual([18]);
    expect(result.chunks.some((chunk) => chunk.id === 17)).toBe(true);
    expect(result.pages).toContain(18);
  });

  it('keeps all pages in an explicit range and reports neighbours', () => {
    const chunks = makeChunks(30);
    const result = retrieve(chunks, '第18到20页分别讲了什么？', {
      topK: 6,
      contextChars: 6000,
      pageCount: 30,
    });

    expect(result.mode).toBe('pages');
    expect(result.requestedPages).toEqual([18, 19, 20]);
    expect(result.pages).toEqual(expect.arrayContaining([18, 19, 20]));
  });

  it('notes out-of-range page questions and falls back', () => {
    const chunks = makeChunks(30);
    const result = retrieve(chunks, '第999页讲了什么？', {
      topK: 6,
      contextChars: 1200,
      pageCount: 30,
    });

    expect(result.requestedPages).toEqual([999]);
    expect(result.note).toContain('超出');
    expect(result.mode).not.toBe('pages');
  });

  it('selects chapter heading and following chunks', () => {
    const chunks: TextChunk[] = [
      { id: 0, pageStart: 1, pageEnd: 1, text: '前言。'.repeat(20) },
      { id: 1, pageStart: 2, pageEnd: 2, text: '第一章 引言。'.repeat(20) },
      { id: 2, pageStart: 3, pageEnd: 3, text: '第一章的后续内容。'.repeat(20) },
      { id: 3, pageStart: 4, pageEnd: 4, text: '第二章 方法。'.repeat(20) },
    ];
    const result = retrieve(chunks, '第一章讲了什么？', {
      topK: 6,
      contextChars: 6000,
      pageCount: 4,
    });

    expect(result.mode).toBe('chapter');
    expect(result.requestedChapter).toBe('第一章');
    expect(result.chunks.map((chunk) => chunk.id)).toEqual([1, 2]);
  });

  it('falls back to keyword retrieval when a chapter heading is missing', () => {
    const chunks = makeChunks(12);
    const result = retrieve(chunks, '第18章讲了什么？', {
      topK: 6,
      contextChars: 2000,
      pageCount: 12,
    });

    expect(result.requestedChapter).toContain('第18章');
    expect(result.note).toContain('未定位到章节标题');
  });
});
