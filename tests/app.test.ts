import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { DocumentStore } from '../server/documents';
import { ChatStore, SessionStore } from '../server/persistence';
import { SettingsStore } from '../server/settings';

let app: Express;
let settingsStore: SettingsStore;
let documentStore: DocumentStore;
let sessionStore: SessionStore;
let chatStore: ChatStore;
let tempDir: string;

beforeEach(() => {
  // 避免项目根 .env 的真实 LLM 配置覆盖测试内的 SettingsStore。
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-llm-app-'));
  settingsStore = new SettingsStore(path.join(tempDir, 'settings.json'));
  documentStore = new DocumentStore(path.join(tempDir, 'library'));
  sessionStore = new SessionStore(path.join(tempDir, 'session.json'));
  chatStore = new ChatStore(path.join(tempDir, 'chats'));
  app = createApp({ settingsStore, documentStore, sessionStore, chatStore });
});

const originalLlmEnv = {
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalLlmEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function stubLlm(content: string, status = 200) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
      new Response(
        JSON.stringify(
          status === 200 ? { choices: [{ message: { content } }] } : { error: { message: content } },
        ),
        { status, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function uploadDocument(): Promise<string> {
  const response = await request(app)
    .post('/api/documents')
    .send({
      name: 'v4.pdf',
      pages: [
        { page: 1, text: '第一页：相对论简介与两个基本假设。'.repeat(12) },
        { page: 2, text: '第二页：光速不变原理与相对性原理。'.repeat(12) },
      ],
    });
  expect(response.status).toBe(201);
  return response.body.docId as string;
}

describe('API', () => {
  it('serves health', async () => {
    const response = await request(app).get('/api/health').expect(200);
    expect(response.body).toMatchObject({ ok: true });
  });

  it('round-trips settings and never returns the raw API key', async () => {
    const saved = await request(app)
      .put('/api/settings')
      .send({ model: 'deepseek-chat', apiKey: 'test-key-test-abcdef123456' })
      .expect(200);

    expect(saved.body.model).toBe('deepseek-chat');
    expect(saved.body.hasApiKey).toBe(true);
    expect(saved.body.apiKey).toBeUndefined();

    const fetched = await request(app).get('/api/settings').expect(200);
    expect(fetched.body.model).toBe('deepseek-chat');
    expect(fetched.body.apiKeyLast4).toBe('3456');
    expect(fetched.body.apiKey).toBeUndefined();
    expect(JSON.stringify(fetched.body)).not.toContain('test-key-test-abcdef123456');
  });

  it('rejects invalid settings payloads', async () => {
    const response = await request(app)
      .put('/api/settings')
      .send({ baseUrl: 'ftp://example.com' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');

    const unknown = await request(app).put('/api/settings').send({ nope: true }).expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('uploads a document and answers with page citations', async () => {
    const fetchMock = stubLlm('相对论基于两个基本假设 [p.2]。');
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '相对论的基本假设是什么？' })
      .expect(200);

    expect(response.body.answer).toContain('[p.2]');
    expect(response.body.notFound).toBe(false);
    expect(response.body.citations[0].page).toBe(2);
    expect(response.body.context.mode).toBe('full');

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages[0]!.content).toContain('只能依据');
    expect(body.messages.at(-1)!.content).toContain('<context>');
  });

  it('marks not-found answers and drops citations', async () => {
    stubLlm('未在文档中找到相关内容。');
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '文档是否提到量子引力？' })
      .expect(200);

    expect(response.body.notFound).toBe(true);
    expect(response.body.citations).toEqual([]);
  });

  it('maps provider auth failures to 401 without leaking the key', async () => {
    await request(app)
      .put('/api/settings')
      .send({ apiKey: 'test-key-secret-key-123456' })
      .expect(200);
    stubLlm('invalid key test-key-secret-key-123456', 401);
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '相对论是什么？' })
      .expect(401);

    expect(response.body.error.code).toBe('LLM_HTTP_ERROR');
    expect(response.body.error.message).not.toContain('test-key-secret-key-123456');
    expect(response.body.error.message).toContain('[REDACTED_KEY]');
  });

  it('returns 404 for an unknown document', async () => {
    const response = await request(app)
      .post('/api/ask')
      .send({ docId: 'missing', question: '问题' })
      .expect(404);
    expect(response.body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('rejects a document with no text layer', async () => {
    const response = await request(app)
      .post('/api/documents')
      .send({ name: 'scan.pdf', pages: [{ page: 1, text: '   ' }] })
      .expect(422);
    expect(response.body.error.code).toBe('NO_TEXT_LAYER');
  });

  it('validates ask requests', async () => {
    const docId = await uploadDocument();
    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '   ' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('tests the LLM connection without saving settings', async () => {
    stubLlm('OK');
    const response = await request(app).post('/api/settings/test').send({}).expect(200);
    expect(response.body.ok).toBe(true);

    const failed = await (async () => {
      stubLlm('bad key test-key-secret-key-123456', 401);
      return request(app)
        .post('/api/settings/test')
        .send({ apiKey: 'test-key-secret-key-123456' })
        .expect(200);
    })();
    expect(failed.body.ok).toBe(false);
    expect(String(failed.body.error)).not.toContain('test-key-secret-key-123456');
  });

  it('rewrites the draft prompt with the configured model', async () => {
    const fetchMock = stubLlm('请具体说明相对论的两条基本假设，并引用页码。');

    const response = await request(app)
      .post('/api/enhance-prompt')
      .send({ question: '相对论假设', documentName: 'v4.pdf', page: 2 })
      .expect(200);

    expect(response.body.enhanced).toBe('请具体说明相对论的两条基本假设，并引用页码。');
    expect(response.body.model).toBe('gpt-4o-mini');
    expect(typeof response.body.latencyMs).toBe('number');

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]!.content).toContain('提示词改写助手');
    expect(body.messages.at(-1)!.content).toContain('相对论假设');
    expect(body.messages.at(-1)!.content).toContain('第 2 页');
  });

  it('validates enhance-prompt requests', async () => {
    const empty = await request(app)
      .post('/api/enhance-prompt')
      .send({ question: '   ' })
      .expect(400);
    expect(empty.body.error.code).toBe('VALIDATION_ERROR');

    const unknown = await request(app)
      .post('/api/enhance-prompt')
      .send({ question: '问题', nope: true })
      .expect(400);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('does not leak the API key when prompt enhancement fails', async () => {
    await request(app)
      .put('/api/settings')
      .send({ apiKey: 'test-key-secret-key-123456' })
      .expect(200);
    stubLlm('invalid key test-key-secret-key-123456', 401);

    const response = await request(app)
      .post('/api/enhance-prompt')
      .send({ question: '相对论假设' })
      .expect(401);

    expect(response.body.error.code).toBe('LLM_HTTP_ERROR');
    expect(response.body.error.message).not.toContain('test-key-secret-key-123456');
    expect(response.body.error.message).toContain('[REDACTED_KEY]');
  });
});

describe('document page updates', () => {
  it('patches OCR/edited page text and later answers use the updated index', async () => {
    const docId = await uploadDocument();

    const patched = await request(app)
      .patch(`/api/documents/${docId}/pages`)
      .send({ pages: [{ page: 2, text: '量子纠缠与贝尔不等式的新内容。'.repeat(20) }] })
      .expect(200);
    expect(patched.body.docId).toBe(docId);
    expect(patched.body.pageCount).toBe(2);

    const fetchMock = stubLlm('量子纠缠是新的索引内容 [p.2]。');
    const answer = await request(app)
      .post('/api/ask')
      .send({ docId, question: '量子纠缠讲了什么？' })
      .expect(200);
    expect(answer.body.citations[0].page).toBe(2);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(body.messages.some((message) => message.content.includes('量子纠缠'))).toBe(true);
  });

  it('returns 404 when patching an unknown document', async () => {
    const response = await request(app)
      .patch('/api/documents/missing/pages')
      .send({ pages: [{ page: 1, text: 'x'.repeat(50) }] })
      .expect(404);
    expect(response.body.error.code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('returns 400 when patching a page outside the document', async () => {
    const docId = await uploadDocument();
    const response = await request(app)
      .patch(`/api/documents/${docId}/pages`)
      .send({ pages: [{ page: 9, text: 'x'.repeat(50) }] })
      .expect(400);
    expect(response.body.error.code).toBe('PAGE_OUT_OF_RANGE');
  });

  it('validates patch payloads', async () => {
    const docId = await uploadDocument();
    const response = await request(app)
      .patch(`/api/documents/${docId}/pages`)
      .send({ pages: [] })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('session persistence', () => {
  it('returns null when no session exists', async () => {
    const response = await request(app).get('/api/session').expect(200);
    expect(response.body).toBeNull();
  });

  it('saves and restores the last document position', async () => {
    const docId = await uploadDocument();
    await request(app)
      .put('/api/session')
      .send({ docId, page: 2, zoom: 1.25, fitWidth: false })
      .expect(200);

    const restored = await request(app).get('/api/session').expect(200);
    expect(restored.body).toMatchObject({
      docId,
      page: 2,
      zoom: 1.25,
      fitWidth: false,
    });
    expect(restored.body.document.docId).toBe(docId);
    expect(restored.body.pages).toHaveLength(2);
    expect(restored.body.pages[1].text).toContain('光速不变原理');
  });

  it('rejects a session for an unknown document and can clear it', async () => {
    const missing = await request(app)
      .put('/api/session')
      .send({ docId: 'missing', page: 1, zoom: 1, fitWidth: true })
      .expect(404);
    expect(missing.body.error.code).toBe('DOCUMENT_NOT_FOUND');

    const docId = await uploadDocument();
    await request(app)
      .put('/api/session')
      .send({ docId, page: 1, zoom: 1, fitWidth: true })
      .expect(200);
    await request(app).delete('/api/session').expect(200);
    const cleared = await request(app).get('/api/session').expect(200);
    expect(cleared.body).toBeNull();
  });

  it('clears the session when its document is deleted', async () => {
    const docId = await uploadDocument();
    await request(app)
      .put('/api/session')
      .send({ docId, page: 1, zoom: 1, fitWidth: true })
      .expect(200);
    await request(app).delete(`/api/documents/${docId}`).expect(200);
    const cleared = await request(app).get('/api/session').expect(200);
    expect(cleared.body).toBeNull();
  });
});

describe('chat archive', () => {
  it('stores multiple conversations per document and lists them', async () => {
    const docId = await uploadDocument();
    const first = [
      { id: 'm1', role: 'user' as const, content: '第一个问题：文档讲了什么？' },
      {
        id: 'm2',
        role: 'assistant' as const,
        content: '相对论的两个基本假设 [p.1]。',
        citations: [{ page: 1, pageEnd: 1, snippet: '相对论', chunkId: 0 }],
        notFound: false,
      },
    ];
    const second = [
      { id: 'm3', role: 'user' as const, content: '第二个问题：目录有哪些章节？' },
      { id: 'm4', role: 'assistant' as const, content: 'Introduction 与第 1–14 章 [p.1]。' },
    ];

    const savedFirst = await request(app)
      .put(`/api/documents/${docId}/chats/conv-a`)
      .send({ messages: first })
      .expect(200);
    expect(savedFirst.body.id).toBe('conv-a');
    expect(savedFirst.body.docId).toBe(docId);
    expect(savedFirst.body.title).toContain('第一个问题');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await request(app)
      .put(`/api/documents/${docId}/chats/conv-b`)
      .send({ messages: second })
      .expect(200);

    const list = await request(app).get(`/api/documents/${docId}/chats`).expect(200);
    expect(list.body.chats).toHaveLength(2);
    expect(list.body.chats[0].id).toBe('conv-b');
    expect(list.body.chats[0].title).toContain('第二个问题');
    expect(list.body.chats[0].messageCount).toBe(2);

    const restored = await request(app)
      .get(`/api/documents/${docId}/chats/conv-a`)
      .expect(200);
    expect(restored.body.messages[1].content).toContain('[p.1]');
  });

  it('deletes one conversation and keeps the others', async () => {
    const docId = await uploadDocument();
    const messages = [{ id: 'm1', role: 'user' as const, content: '保留或删除' }];
    await request(app)
      .put(`/api/documents/${docId}/chats/keep`)
      .send({ messages })
      .expect(200);
    await request(app)
      .put(`/api/documents/${docId}/chats/drop`)
      .send({ messages })
      .expect(200);

    const deleted = await request(app)
      .delete(`/api/documents/${docId}/chats/drop`)
      .expect(200);
    expect(deleted.body.deleted).toBe(true);

    const list = await request(app).get(`/api/documents/${docId}/chats`).expect(200);
    expect(list.body.chats.map((chat: { id: string }) => chat.id)).toEqual(['keep']);

    const missing = await request(app)
      .get(`/api/documents/${docId}/chats/drop`)
      .expect(404);
    expect(missing.body.error.code).toBe('CHAT_NOT_FOUND');
  });

  it('validates chat payloads and unknown documents', async () => {
    const invalid = await request(app)
      .put('/api/documents/missing/chats/conv-a')
      .send({ messages: [] })
      .expect(404);
    expect(invalid.body.error.code).toBe('DOCUMENT_NOT_FOUND');

    const docId = await uploadDocument();
    const badRole = await request(app)
      .put(`/api/documents/${docId}/chats/conv-a`)
      .send({ messages: [{ id: 'x', role: 'system', content: 'nope' }] })
      .expect(400);
    expect(badRole.body.error.code).toBe('VALIDATION_ERROR');

    const missing = await request(app).get(`/api/documents/${docId}/chats/nope`).expect(404);
    expect(missing.body.error.code).toBe('CHAT_NOT_FOUND');
  });
});

describe('PDF file persistence', () => {
  it('stores the original PDF bytes and serves them for restore', async () => {
    const docId = await uploadDocument();
    const pdfBytes = Buffer.from('%PDF-1.4\n% local test pdf\n%%EOF\n');

    await request(app)
      .post(`/api/documents/${docId}/file`)
      .set('Content-Type', 'application/pdf')
      .send(pdfBytes)
      .expect(201);

    const file = await request(app).get(`/api/documents/${docId}/file`).expect(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.body.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('rejects non-PDF payloads and unknown documents', async () => {
    const docId = await uploadDocument();
    const bad = await request(app)
      .post(`/api/documents/${docId}/file`)
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('not a pdf'))
      .expect(400);
    expect(bad.body.error.code).toBe('INVALID_PDF');

    await request(app)
      .post('/api/documents/missing/file')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('%PDF-1.4\n'))
      .expect(404);
  });
});

describe('page intent responses', () => {
  it('returns page context and target pages for a single-page question', async () => {
    const fetchMock = stubLlm('第二页介绍的是光速不变原理。');
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '第2页讲了什么？' })
      .expect(200);

    expect(response.body.context.mode).toBe('pages');
    expect(response.body.context.requestedPages).toEqual([2]);
    expect(response.body.context.pages).toContain(2);
    expect(response.body.context.note).toBeUndefined();

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1]?.body as string) ?? '{}'));
    const userMessage = body.messages?.[body.messages.length - 1]?.content as string;
    expect(userMessage).toContain('<page');
    expect(userMessage).toContain('第二页');
  });

  it('keeps a page range in the context metadata', async () => {
    stubLlm('两页分别介绍相对论假设和光速不变。');
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '第1-2页分别讲了什么？' })
      .expect(200);

    expect(response.body.context.mode).toBe('pages');
    expect(response.body.context.requestedPages).toEqual([1, 2]);
    expect(response.body.context.pages).toEqual(expect.arrayContaining([1, 2]));
  });

  it('falls back citations to the requested page when the answer has no marker', async () => {
    stubLlm('第二页内容是光速不变原理。');
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '第2页讲了什么？' })
      .expect(200);

    expect(response.body.citations.length).toBeGreaterThan(0);
    expect(response.body.citations[0].page).toBe(2);
  });

  it('reports out-of-range pages and falls back to ordinary retrieval', async () => {
    stubLlm('未在文档中找到相关内容。');
    const docId = await uploadDocument();

    const response = await request(app)
      .post('/api/ask')
      .send({ docId, question: '第99页讲了什么？' })
      .expect(200);

    expect(response.body.context.requestedPages).toEqual([99]);
    expect(response.body.context.mode).not.toBe('pages');
    expect(response.body.context.note).toContain('超出');
  });
});
