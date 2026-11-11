import http from 'node:http';

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
}

const PORT = Number(process.env.MOCK_LLM_PORT ?? 9999);
let lastRequest: ChatRequest | null = null;

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/last-request') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(lastRequest ?? {}));
    return;
  }

  if (request.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      let parsed: ChatRequest = {};
      try {
        parsed = JSON.parse(body) as ChatRequest;
      } catch {
        // keep defaults; the client sends valid JSON
      }
      lastRequest = parsed;

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const question = lastUser?.content ?? '';
      const systemText = messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      const isEnhancementRequest = /提示词改写助手/.test(systemText);

      if (isEnhancementRequest) {
        if (/触发失败/.test(question)) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'mock enhancement failure' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        setTimeout(() => {
          response.end(
            JSON.stringify({
              id: 'chatcmpl-mock-enhance',
              object: 'chat.completion',
              model: parsed.model ?? 'mock-model',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: '请具体说明相对论的两条基本假设，并分别引用文档页码。',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 80, completion_tokens: 22, total_tokens: 102 },
            }),
          );
        }, 350);
        return;
      }

      const notFound = /量子引力|quantum gravity|火星|weather on mars/i.test(question);
      const asksForContents = /目录|contents|table of contents/i.test(question);

      const content = notFound
        ? '未在文档中找到相关内容。'
        : asksForContents
          ? '这份文档是物理教材的目录，涵盖狭义相对论与量子力学等章节 [p.1]。'
          : '相对论基于相对性原理与光速不变原理 [p.2]。';

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          model: parsed.model ?? 'mock-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
        }),
      );
    });
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'not found' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}`);
});
