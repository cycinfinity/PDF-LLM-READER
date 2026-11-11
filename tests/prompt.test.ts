import { describe, expect, it } from 'vitest';
import type { TextChunk } from '../server/chunk';
import {
  GROUNDING_RULES,
  buildCitations,
  buildMessages,
  extractReferencedPages,
  formatContext,
  isNotFoundAnswer,
  trimHistory,
} from '../server/prompt';

const chunks: TextChunk[] = [
  { id: 0, pageStart: 1, pageEnd: 2, text: '第一页与第二页的内容。'.repeat(5) },
  { id: 1, pageStart: 3, pageEnd: 4, text: '第三页与第四页的内容。'.repeat(5) },
];

describe('extractReferencedPages', () => {
  it('parses bracket, range, and inline page markers', () => {
    const answer = '结论见 [p.3] 与 [p.5-p.6]，另见第 8 页与 p.10。';
    expect(extractReferencedPages(answer, 12)).toEqual([3, 5, 6, 8, 10]);
  });

  it('parses comma separated bracket lists', () => {
    expect(extractReferencedPages('见 [3, 5]', 10)).toEqual([3, 5]);
  });

  it('drops pages outside the document', () => {
    expect(extractReferencedPages('[p.99] 第 200 页', 10)).toEqual([]);
  });
});

describe('buildCitations', () => {
  it('maps referenced pages to the chunks that contain them', () => {
    const citations = buildCitations(chunks, [2, 4]);
    expect(citations.map((citation) => citation.page)).toEqual([2, 4]);
    expect(citations.map((citation) => citation.chunkId)).toEqual([0, 1]);
    expect(citations[0]!.snippet.length).toBeLessThanOrEqual(160);
  });

  it('falls back to the first chunks when the answer has no page markers', () => {
    const citations = buildCitations(chunks, []);
    expect(citations.map((citation) => citation.page)).toEqual([1, 3]);
  });
});

describe('formatContext', () => {
  it('labels single-page and multi-page chunks', () => {
    expect(formatContext([{ id: 0, pageStart: 2, pageEnd: 2, text: '单页' }])).toContain('<page 2>');
    expect(formatContext([{ id: 0, pageStart: 2, pageEnd: 3, text: '跨页' }])).toContain(
      '<pages 2-3>',
    );
  });
});

describe('buildMessages', () => {
  it('combines the custom persona with fixed grounding rules', () => {
    const messages = buildMessages({
      systemPrompt: '自定义角色：物理学助教。',
      chunks: [{ id: 0, pageStart: 2, pageEnd: 2, text: '光速不变。' }],
      question: '光速为什么不变？',
      history: [{ role: 'user', content: '上一个问题' }],
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('自定义角色：物理学助教。');
    expect(messages[0]!.content).toContain(GROUNDING_RULES);
    expect(messages[1]).toEqual({ role: 'user', content: '上一个问题' });
    expect(messages[2]!.content).toContain('<page 2>');
    expect(messages[2]!.content).toContain('<question>');
  });
});

describe('trimHistory', () => {
  it('keeps only the last three turns and caps content length', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `${index}:${'x'.repeat(1200)}`,
    }));
    const trimmed = trimHistory(history);
    expect(trimmed).toHaveLength(6);
    expect(trimmed[0]!.content.startsWith('4:')).toBe(true);
    expect(trimmed[0]!.content.length).toBe(1000);
  });
});

describe('isNotFoundAnswer', () => {
  it('recognizes Chinese and English not-found answers', () => {
    expect(isNotFoundAnswer('未在文档中找到相关内容。')).toBe(true);
    expect(isNotFoundAnswer('The document does not mention this topic.')).toBe(true);
    expect(isNotFoundAnswer('相对论基于两个基本假设 [p.2]。')).toBe(false);
  });
});
