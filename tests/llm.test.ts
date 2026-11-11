import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmError, callChatCompletion, normalizeChatCompletionsUrl } from '../server/llm';

const baseConfig = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'test-key-test-123456',
  temperature: 0.2,
  maxTokens: 64,
};

const messages = [{ role: 'user' as const, content: '你好' }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('normalizeChatCompletionsUrl', () => {
  it.each([
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/v1/chat/completions'],
    ['http://127.0.0.1:11434/v1/chat/completions', 'http://127.0.0.1:11434/v1/chat/completions'],
    ['https://x.example/chat/completions?x=1', 'https://x.example/chat/completions?x=1'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeChatCompletionsUrl(input)).toBe(expected);
  });
});

describe('callChatCompletion', () => {
  it('sends an OpenAI-compatible request and parses content and usage', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({
          choices: [{ message: { content: ' 答案 [p.2] ' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await callChatCompletion(baseConfig, { messages });

    expect(result.content).toBe('答案 [p.2]');
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.example.com/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key-test-123456');
    const body = JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'test-model',
      stream: false,
      temperature: 0.2,
      max_tokens: 64,
    });
  });

  it('omits the Authorization header when no API key is configured', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
        jsonResponse({ choices: [{ message: { content: 'OK' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await callChatCompletion({ ...baseConfig, apiKey: '' }, { messages });

    const init = fetchMock.mock.calls[0]![1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('maps provider 401 errors to LlmError and redacts the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { message: 'bad key test-key-test-123456' } }, 401)),
    );

    let caught: unknown;
    try {
      await callChatCompletion(baseConfig, { messages });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LlmError);
    const llmError = caught as LlmError;
    expect(llmError.status).toBe(401);
    expect(llmError.code).toBe('LLM_HTTP_ERROR');
    expect(llmError.message).toContain('API Key 无效');
    expect(llmError.message).not.toContain('test-key-test-123456');
    expect(llmError.message).toContain('[REDACTED_KEY]');
  });

  it('rejects empty responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: '   ' } }] })),
    );

    await expect(callChatCompletion(baseConfig, { messages })).rejects.toMatchObject({
      status: 502,
      code: 'LLM_EMPTY_RESPONSE',
    });
  });

  it('maps network failures to LlmError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(callChatCompletion(baseConfig, { messages })).rejects.toMatchObject({
      status: 502,
      code: 'LLM_NETWORK_ERROR',
    });
  });
});
