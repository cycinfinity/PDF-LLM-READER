import { redactSecrets } from './errors';
import type { LlmMessage } from './prompt';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface LlmResult {
  content: string;
  model: string;
  latencyMs: number;
  usage?: LlmUsage;
}

export class LlmError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.code = code;
  }
}

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (/\/chat\/completions(?:\?|$)/i.test(trimmed)) return trimmed;
  if (/\/v1$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function extractProviderMessage(body: unknown, rawText: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof record.message === 'string') return record.message;
    if (typeof record.detail === 'string') return record.detail;
  }
  return rawText.slice(0, 300);
}

function friendlyError(status: number, providerMessage: string): string {
  const detail = providerMessage.trim() ? `服务商返回：${providerMessage.trim()}` : '服务商未返回错误详情。';
  switch (status) {
    case 400:
      return `请求被服务商拒绝（400）。请检查模型名、参数与消息格式。${detail}`;
    case 401:
      return `API Key 无效或没有权限（401）。请检查 API Key 是否与 Base URL/服务商匹配。${detail}`;
    case 403:
      return `访问被拒绝（403）。请确认当前 API Key 有权使用该模型。${detail}`;
    case 404:
      return `接口或模型不存在（404）。请检查 Base URL 是否需要以 /v1 结尾，以及模型名是否正确。${detail}`;
    case 429:
      return `请求频率或额度受限（429）。请稍后重试，或检查账户额度。${detail}`;
    case 500:
    case 502:
    case 503:
    case 504:
      return `服务商暂时不可用（${status}）。请稍后重试。${detail}`;
    default:
      return `调用模型失败（HTTP ${status}）。${detail}`;
  }
}

function extractContent(body: unknown): string {
  const record = body as
    | {
        choices?: Array<{
          message?: { content?: string | Array<{ type?: string; text?: string }> };
          text?: string;
        }>;
      }
    | undefined;
  const choice = record?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  if (typeof choice?.text === 'string') return choice.text;
  return '';
}

interface CompletionOptions {
  messages: LlmMessage[];
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

export async function callChatCompletion(
  config: LlmConfig,
  options: CompletionOptions,
): Promise<LlmResult> {
  const url = normalizeChatCompletionsUrl(config.baseUrl);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages: options.messages,
        temperature: options.temperature ?? config.temperature,
        max_tokens: options.maxTokens ?? config.maxTokens,
        stream: false,
      }),
    });

    const rawText = await response.text();
    let body: unknown = undefined;
    if (rawText) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = undefined;
      }
    }

    if (!response.ok) {
      const providerMessage = redactSecrets(extractProviderMessage(body, rawText), config.apiKey);
      throw new LlmError(response.status, 'LLM_HTTP_ERROR', friendlyError(response.status, providerMessage));
    }

    const content = extractContent(body).trim();
    if (!content) {
      throw new LlmError(502, 'LLM_EMPTY_RESPONSE', '服务商返回了空内容。请检查模型名与该接口的兼容性。');
    }

    const usageRecord = (body as { usage?: Record<string, unknown> } | undefined)?.usage;
    const usage: LlmUsage | undefined = usageRecord
      ? {
          promptTokens: typeof usageRecord.prompt_tokens === 'number' ? usageRecord.prompt_tokens : undefined,
          completionTokens:
            typeof usageRecord.completion_tokens === 'number' ? usageRecord.completion_tokens : undefined,
          totalTokens: typeof usageRecord.total_tokens === 'number' ? usageRecord.total_tokens : undefined,
        }
      : undefined;

    return {
      content,
      model: config.model,
      latencyMs: Date.now() - startedAt,
      usage,
    };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmError(504, 'LLM_TIMEOUT', `调用模型超时（${Math.round(timeoutMs / 1000)} 秒）。请检查网络或 Base URL。`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new LlmError(
      502,
      'LLM_NETWORK_ERROR',
      `无法连接模型服务：${redactSecrets(message, config.apiKey)}。请检查 Base URL 与网络。`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function testChatCompletion(config: LlmConfig): Promise<{ latencyMs: number; model: string }> {
  const result = await callChatCompletion(config, {
    messages: [
      { role: 'system', content: '你是一个连接测试助手。' },
      { role: 'user', content: '请只回复 OK。' },
    ],
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 25_000,
  });
  return { latencyMs: result.latencyMs, model: result.model };
}
