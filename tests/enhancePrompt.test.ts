import { describe, expect, it } from 'vitest';
import {
  buildEnhanceMessages,
  ENHANCE_SYSTEM_PROMPT,
  sanitizeEnhancedPrompt,
} from '../server/enhancePrompt';

describe('enhancePrompt', () => {
  it('builds a rewrite prompt with document context and the original question', () => {
    const messages = buildEnhanceMessages({
      question: '第18页讲了什么？',
      documentName: 'Looking for Alaska.pdf',
      page: 18,
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('提示词改写助手');
    expect(messages[0]!.content).toContain('不要回答问题');
    expect(messages[0]!.content).toBe(ENHANCE_SYSTEM_PROMPT);
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toContain('Looking for Alaska.pdf');
    expect(messages[1]!.content).toContain('第 18 页');
    expect(messages[1]!.content).toContain('第18页讲了什么？');
  });

  it('falls back to placeholder document context and page 1', () => {
    const messages = buildEnhanceMessages({ question: '解释一下' });
    expect(messages[1]!.content).toContain('（当前文档）');
    expect(messages[1]!.content).toContain('第 1 页');
  });

  it('strips code fences, rewrite labels and wrapping quotes', () => {
    expect(sanitizeEnhancedPrompt('```text\n改写后：请概括第 3 页的三个要点。\n```')).toBe(
      '请概括第 3 页的三个要点。',
    );
    expect(sanitizeEnhancedPrompt('“请对比第 2 页与第 4 页的观点。”')).toBe(
      '请对比第 2 页与第 4 页的观点。',
    );
    expect(sanitizeEnhancedPrompt('增强提示词: 请列出第 5 页的公式。')).toBe(
      '请列出第 5 页的公式。',
    );
  });

  it('returns an empty string for blank output', () => {
    expect(sanitizeEnhancedPrompt('   ')).toBe('');
    expect(sanitizeEnhancedPrompt('```\n\n```')).toBe('');
  });
});
