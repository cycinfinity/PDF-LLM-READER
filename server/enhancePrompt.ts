import type { LlmMessage } from './prompt';

/** Maximum number of characters accepted for the draft before rewriting. */
export const ENHANCE_QUESTION_MAX_CHARS = 2000;

/** Maximum number of characters kept from the rewritten result. */
export const ENHANCE_RESULT_MAX_CHARS = 2000;

export interface EnhancePromptInput {
  question: string;
  documentName?: string;
  page?: number;
}

export const ENHANCE_SYSTEM_PROMPT = [
  '你是一个提示词改写助手。用户正在一份 PDF 文档的阅读器里输入问题，',
  '请把这个问题改写成更清晰、更具体、更容易被文档问答系统回答的提示词。',
  '',
  '要求：',
  '1. 保留原问题的核心意图与语言，不要改变问题含义。',
  '2. 把模糊的指代补全（如“这里 / 这一页 / 它”），可结合文件名与当前页，但不要编造文档内容。',
  '3. 明确希望的回答形式（例如概括、对比、列出要点、解释原因、引用页码），控制在 3 句话、200 字以内。',
  '4. 不要回答问题，不要输出答案，不要写“改写后：”之类的前缀或解释，只输出改写后的提示词本身。',
].join('\n');

/** Builds the two-message prompt used for rewriting a question. */
export function buildEnhanceMessages(input: EnhancePromptInput): LlmMessage[] {
  const question = input.question.trim();
  const documentName = input.documentName?.trim() || '（当前文档）';
  const page = typeof input.page === 'number' && Number.isFinite(input.page) ? input.page : 1;

  return [
    { role: 'system', content: ENHANCE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `文档：${documentName}`,
        `当前页：第 ${page} 页`,
        '',
        '原始问题：',
        question,
        '',
        '请只输出改写后的提示词。',
      ].join('\n'),
    },
  ];
}

/**
 * Removes common wrappers a model may add (code fences, labels, quotes) and
 * normalises whitespace. Returns an empty string when nothing usable remains.
 */
export function sanitizeEnhancedPrompt(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  text = text.replace(
    /^(?:改写|增强|优化|润色)(?:后|过的)?(?:的)?(?:提示词|问题|提问)?\s*[:：]\s*/i,
    '',
  );
  text = text.replace(/^["'“”「『]+/, '').replace(/["'“”」』]+$/, '').trim();
  text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  return text.slice(0, ENHANCE_RESULT_MAX_CHARS);
}
