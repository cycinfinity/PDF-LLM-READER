import { describe, expect, it } from 'vitest';
import {
  MAX_FOCUS_PAGES,
  parseChapterIntent,
  parseChineseNumber,
  parsePageIntent,
  parseQuestionIntent,
} from '../server/pageIntent';

describe('parseChineseNumber', () => {
  it('converts common Chinese numerals', () => {
    expect(parseChineseNumber('十八')).toBe(18);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('二十八')).toBe(28);
    expect(parseChineseNumber('一百零八')).toBe(108);
    expect(parseChineseNumber('两百')).toBe(200);
    expect(parseChineseNumber('245')).toBe(245);
  });

  it('rejects non-numeric text', () => {
    expect(parseChineseNumber('第')).toBeNull();
    expect(parseChineseNumber('abc')).toBeNull();
  });
});

describe('parsePageIntent', () => {
  it('parses single pages in Chinese and English', () => {
    expect(parsePageIntent('第18页讲了什么？')?.pages).toEqual([18]);
    expect(parsePageIntent('第 18 页的内容')?.pages).toEqual([18]);
    expect(parsePageIntent('第十八页的标题')?.pages).toEqual([18]);
    expect(parsePageIntent('what does page 18 say?')?.pages).toEqual([18]);
    expect(parsePageIntent('请解释 p.18 的公式')?.pages).toEqual([18]);
  });

  it('parses ranges', () => {
    expect(parsePageIntent('第18-20页分别讲了什么？')).toMatchObject({
      kind: 'pages',
      pages: [18, 19, 20],
      ranges: [{ start: 18, end: 20 }],
    });
    expect(parsePageIntent('第18至20页的内容')?.pages).toEqual([18, 19, 20]);
    expect(parsePageIntent('pages 18-20')?.pages).toEqual([18, 19, 20]);
    expect(parsePageIntent('pp. 18-20')?.pages).toEqual([18, 19, 20]);
  });

  it('parses page lists', () => {
    expect(parsePageIntent('第18、19、20页讲什么')?.pages).toEqual([18, 19, 20]);
    expect(parsePageIntent('pages 18, 19 and 20')?.pages).toEqual([18, 19, 20]);
  });

  it('clamps and reports out-of-range pages', () => {
    const intent = parsePageIntent('第200-300页', { pageCount: 246, maxFocusPages: 100 });
    expect(intent?.pages).toEqual(Array.from({ length: 47 }, (_, index) => 200 + index));
    expect(intent?.outOfRangePages).toContain(247);
    expect(intent?.outOfRangePages).toContain(300);

    const missing = parsePageIntent('第999页讲了什么', { pageCount: 246 });
    expect(missing?.pages).toEqual([]);
    expect(missing?.requestedPages).toEqual([999]);
    expect(missing?.outOfRangePages).toEqual([999]);
  });

  it('caps the number of focused pages', () => {
    const intent = parsePageIntent('第1-30页', { pageCount: 100, maxFocusPages: MAX_FOCUS_PAGES });
    expect(intent?.pages).toHaveLength(MAX_FOCUS_PAGES);
    expect(intent?.truncatedFocus).toBe(true);
  });

  it('does not match version numbers or bare ranges', () => {
    expect(parsePageIntent('v1.18 有什么变化')).toBeNull();
    expect(parsePageIntent('18-20 的统计')).toBeNull();
    expect(parsePageIntent('2026年发生了什么')).toBeNull();
  });
});

describe('parseChapterIntent', () => {
  it('parses Chinese chapters and sections', () => {
    expect(parseChapterIntent('第18章讲了什么？')).toMatchObject({
      kind: 'chapter',
      number: '18',
      label: '第18章',
    });
    expect(parseChapterIntent('第三章节的内容呢？')?.number).toBe('3');
  });

  it('parses English chapters and sections', () => {
    expect(parseChapterIntent('Chapter 12 summary')?.label).toBe('Chapter 12');
    expect(parseChapterIntent('Section 2.3 的内容')?.label).toMatch(/Section 2\.3/);
  });

  it('returns null when there is no chapter reference', () => {
    expect(parseChapterIntent('这份文档讲了什么')).toBeNull();
  });
});

describe('parseQuestionIntent', () => {
  it('gives page intent priority over summary phrasing', () => {
    expect(parseQuestionIntent('总结第18页的内容')?.kind).toBe('pages');
    expect(parseQuestionIntent('第18页讲了什么')?.kind).toBe('pages');
  });

  it('falls back to chapter intent', () => {
    expect(parseQuestionIntent('第18章讲了什么')?.kind).toBe('chapter');
  });

  it('returns null for ordinary questions', () => {
    expect(parseQuestionIntent('什么是相对性原理？')).toBeNull();
  });
});
