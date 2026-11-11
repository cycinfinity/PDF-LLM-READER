import { describe, expect, it } from 'vitest';
import { buildChunks, cleanPages, corpusStats, normalizeText } from '../server/chunk';

describe('normalizeText', () => {
  it('normalizes full-width characters and collapses whitespace', () => {
    expect(normalizeText('  Ａ  Ｂ\t\r\n\r\n\r\nC  ')).toBe('A B\n\nC');
  });
});

describe('cleanPages', () => {
  const pages = Array.from({ length: 6 }, (_, index) => ({
    page: index + 1,
    text: `Stirling Reader\n${index + 1}\n第${index + 1}页正文内容，包含唯一信息 ${index + 1}。\nStirling Reader`,
  }));

  it('removes page-number lines and repeated running headers', () => {
    const cleaned = cleanPages(pages);
    expect(cleaned).toHaveLength(6);
    expect(cleaned[0]!.text).not.toContain('Stirling Reader');
    expect(cleaned[0]!.text).not.toContain('\n1\n');
    expect(cleaned[0]!.text).toContain('第1页正文内容');
  });

  it('keeps repeated body lines that are not at page edges', () => {
    const repeated = Array.from({ length: 5 }, (_, index) => ({
      page: index + 1,
      text: `正文开头第${index + 1}页\n这是每页都出现的正文句子。\n结尾第${index + 1}页`,
    }));
    const cleaned = cleanPages(repeated);
    expect(cleaned.every((page) => page.text.includes('这是每页都出现的正文句子。'))).toBe(true);
  });
});

describe('buildChunks', () => {
  it('maps chunk boundaries back to PDF pages and respects the size limit', () => {
    const pages = [
      { page: 1, text: 'PAGE_ONE 简短第一页' },
      { page: 2, text: `PAGE_TWO ${'乙'.repeat(300)}` },
      { page: 3, text: `PAGE_THREE ${'丙'.repeat(300)}` },
    ];

    const chunks = buildChunks(pages, { chunkSize: 200, overlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.pageStart).toBe(1);
    expect(chunks.some((chunk) => chunk.pageStart === 2 && chunk.pageEnd === 3)).toBe(true);
    expect(chunks.at(-1)!.pageEnd).toBe(3);

    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(200);
      expect(chunk.pageStart).toBeLessThanOrEqual(chunk.pageEnd);
    }
  });

  it('skips empty pages when attributing pages', () => {
    const chunks = buildChunks(
      [
        { page: 1, text: '' },
        { page: 2, text: '只有第二页有文字，'.repeat(20) },
      ],
      { chunkSize: 300, overlap: 30 },
    );

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.pageStart === 2 && chunk.pageEnd === 2)).toBe(true);
  });

  it('produces no chunks when every page is empty', () => {
    expect(buildChunks([{ page: 1, text: '   ' }])).toHaveLength(0);
  });

  it('computes corpus stats', () => {
    const pages = [
      { page: 1, text: 'abcde' },
      { page: 2, text: '   ' },
      { page: 3, text: 'fghij' },
    ];
    const chunks = buildChunks(pages);
    const stats = corpusStats(pages, chunks);
    expect(stats.charCount).toBe(10);
    expect(stats.pageCount).toBe(3);
    expect(stats.emptyPageCount).toBe(1);
    expect(stats.chunkCount).toBe(chunks.length);
  });
});
