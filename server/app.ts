import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { APP_ROOT, IS_PRODUCTION } from './config';
import { AppError, redactSecrets } from './errors';
import { DocumentStore, DOCUMENT_LIMITS, toDocumentInfo } from './documents';
import { buildEnhanceMessages, sanitizeEnhancedPrompt } from './enhancePrompt';
import { LlmError, callChatCompletion, testChatCompletion, type LlmConfig } from './llm';
import { ChatStore, SessionStore, type StoredChatMessage } from './persistence';
import {
  buildCitations,
  buildMessages,
  extractReferencedPages,
  historyCharCount,
  isNotFoundAnswer,
  trimHistory,
} from './prompt';
import { retrieve } from './retrieve';
import { SettingsStore, settingsPatchSchema } from './settings';

const pageSchema = z
  .object({
    page: z.number().int().min(1).max(10_000),
    text: z.string().max(200_000),
  })
  .strict();

const uploadSchema = z
  .object({
    name: z.string().trim().min(1, '文件名不能为空').max(DOCUMENT_LIMITS.maxNameLength),
    pages: z.array(pageSchema).min(1, '没有可索引的页面').max(DOCUMENT_LIMITS.maxPages + 100),
  })
  .strict();

const updatePagesSchema = z
  .object({
    pages: z.array(pageSchema).min(1, '没有要更新的页面').max(DOCUMENT_LIMITS.maxPages + 100),
  })
  .strict();

const askSchema = z
  .object({
    docId: z.string().min(1).max(100),
    question: z.string().trim().min(1, '问题不能为空').max(2000, '问题过长（最多 2000 字符）'),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(20_000),
        }),
      )
      .max(40)
      .optional(),
  })
  .strict();

const enhanceSchema = z
  .object({
    question: z.string().trim().min(1, '问题不能为空').max(2000, '问题过长（最多 2000 字符）'),
    documentName: z.string().trim().max(DOCUMENT_LIMITS.maxNameLength).optional(),
    page: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const sessionSchema = z
  .object({
    docId: z.string().min(1).max(100),
    page: z.number().int().min(1).max(100_000),
    zoom: z.number().min(0.5).max(2),
    fitWidth: z.boolean(),
  })
  .strict();

const chatMessageSchema = z
  .object({
    id: z.string().min(1).max(100),
    role: z.enum(['user', 'assistant']),
    content: z.string().max(20_000),
    citations: z.array(z.unknown()).max(50).optional(),
    notFound: z.boolean().optional(),
    contextInfo: z.unknown().optional(),
    createdAt: z.string().max(50).optional(),
  })
  .strict();

const chatSaveSchema = z
  .object({
    messages: z.array(chatMessageSchema).max(300),
  })
  .strict();

export interface AppDeps {
  settingsStore: SettingsStore;
  documentStore: DocumentStore;
  sessionStore: SessionStore;
  chatStore: ChatStore;
}

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return '请求参数不合法。';
  const fieldPath = issue.path.join('.');
  return fieldPath ? `${fieldPath}: ${issue.message}` : issue.message;
}

function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: zodMessage(error),
      details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  });
}

function llmConfigFromEffective(settings: {
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}): LlmConfig {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
  };
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  const { settingsStore, documentStore, sessionStore, chatStore } = deps;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '12mb' }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      // Deliberately do not log bodies, prompts, or authorization headers.
      console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    next();
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, version: '0.1.0' });
  });

  app.get('/api/settings', (_req: Request, res: Response) => {
    res.json(settingsStore.publicSettings());
  });

  app.put('/api/settings', (req: Request, res: Response) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    settingsStore.update(parsed.data);
    res.json(settingsStore.publicSettings());
  });

  app.post('/api/settings/test', async (req: Request, res: Response) => {
    const parsed = settingsPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const effective = settingsStore.effective();
    const draft = parsed.data;
    const apiKey =
      draft.clearApiKey === true
        ? ''
        : draft.apiKey && draft.apiKey.trim().length > 0
          ? draft.apiKey.trim()
          : effective.apiKey;

    const config: LlmConfig = {
      baseUrl: draft.baseUrl ?? effective.baseUrl,
      model: draft.model ?? effective.model,
      apiKey,
      temperature: effective.temperature,
      maxTokens: effective.maxTokens,
    };

    try {
      const result = await testChatCompletion(config);
      res.json({ ok: true, latencyMs: result.latencyMs, model: result.model });
    } catch (error) {
      if (error instanceof LlmError) {
        res.json({ ok: false, error: redactSecrets(error.message, apiKey) });
        return;
      }
      throw error;
    }
  });

  app.post('/api/documents', (req: Request, res: Response) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const { name, pages } = parsed.data;
    if (pages.length > DOCUMENT_LIMITS.maxPages) {
      res.status(413).json({
        error: {
          code: 'TOO_MANY_PAGES',
          message: `页数超过 ${DOCUMENT_LIMITS.maxPages} 页上限，请拆分 PDF 后再试。`,
        },
      });
      return;
    }

    try {
      const info = documentStore.add(name, pages);
      res.status(201).json(info);
    } catch (error) {
      if (error instanceof AppError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  });

  app.delete('/api/documents/:id', (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const deleted = documentStore.delete(documentId);
    if (!deleted) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在或已被删除。' } });
      return;
    }
    chatStore.deleteAll(documentId);
    if (sessionStore.get()?.docId === documentId) sessionStore.clear();
    res.json({ ok: true });
  });

  app.patch('/api/documents/:id/pages', (req: Request, res: Response) => {
    const parsed = updatePagesSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    try {
      const info = documentStore.updatePages(documentId, parsed.data.pages);
      res.json(info);
    } catch (error) {
      if (error instanceof AppError) {
        res.status(error.status).json({ error: { code: error.code, message: error.message } });
        return;
      }
      throw error;
    }
  });

  app.get('/api/session', (_req: Request, res: Response) => {
    const session = sessionStore.get();
    if (!session) {
      res.json(null);
      return;
    }
    const document = documentStore.get(session.docId);
    if (!document) {
      sessionStore.clear();
      res.json(null);
      return;
    }
    res.json({ ...session, document: toDocumentInfo(document), pages: document.pages });
  });

  app.put('/api/session', (req: Request, res: Response) => {
    const parsed = sessionSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    if (!documentStore.get(parsed.data.docId)) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
      return;
    }
    res.json(sessionStore.save(parsed.data));
  });

  app.delete('/api/session', (_req: Request, res: Response) => {
    sessionStore.clear();
    res.json({ ok: true });
  });

  app.get('/api/documents/:id', (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const document = documentStore.get(documentId);
    if (!document) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
      return;
    }
    res.json({ document: toDocumentInfo(document), pages: document.pages });
  });

  app.post(
    '/api/documents/:id/file',
    express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '64mb' }),
    (req: Request, res: Response) => {
      const documentId = typeof req.params.id === 'string' ? req.params.id : '';
      if (!documentStore.get(documentId)) {
        res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
        return;
      }
      const body: unknown = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({
          error: { code: 'INVALID_PDF', message: '请求体必须是 PDF 二进制（Content-Type: application/pdf）。' },
        });
        return;
      }
      if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
        res.status(400).json({ error: { code: 'INVALID_PDF', message: '文件头不是 PDF（%PDF-）。' } });
        return;
      }
      documentStore.savePdf(documentId, body);
      res.status(201).json({ ok: true, size: body.length });
    },
  );

  app.get('/api/documents/:id/file', (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const filePath = documentStore.getPdfPath(documentId);
    if (!filePath) {
      res.status(404).json({
        error: { code: 'PDF_FILE_NOT_FOUND', message: 'PDF 原文件未保存，无法恢复。请重新打开文件。' },
      });
      return;
    }
    res.type('application/pdf');
    // `dotfiles: 'allow'` is required when DATA_DIR lives under a hidden folder
    // (e.g. the E2E `.e2e-data` directory); Express's send would otherwise 404.
    res.sendFile(path.resolve(filePath), { dotfiles: 'allow' });
  });

  app.get('/api/documents/:id/chats', (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    if (!documentStore.get(documentId)) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
      return;
    }
    res.json({ chats: chatStore.list(documentId) });
  });

  app.get('/api/documents/:id/chats/:chatId', (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const chatId = typeof req.params.chatId === 'string' ? req.params.chatId : '';
    if (!documentStore.get(documentId)) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
      return;
    }
    const archive = chatStore.get(documentId, chatId);
    if (!archive) {
      res.status(404).json({ error: { code: 'CHAT_NOT_FOUND', message: '对话存档不存在或已被删除。' } });
      return;
    }
    res.json(archive);
  });

  app.put('/api/documents/:id/chats/:chatId', (req: Request, res: Response) => {
    const parsed = chatSaveSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const chatId = typeof req.params.chatId === 'string' ? req.params.chatId : '';
    if (!documentStore.get(documentId)) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
      return;
    }
    res.json(chatStore.save(documentId, chatId, parsed.data.messages as StoredChatMessage[]));
  });

  app.delete('/api/documents/:id/chats/:chatId', (req: Request, res: Response) => {
    const documentId = typeof req.params.id === 'string' ? req.params.id : '';
    const chatId = typeof req.params.chatId === 'string' ? req.params.chatId : '';
    if (!documentStore.get(documentId)) {
      res.status(404).json({ error: { code: 'DOCUMENT_NOT_FOUND', message: '文档不存在。' } });
      return;
    }
    const deleted = chatStore.delete(documentId, chatId);
    res.json({ ok: true, deleted });
  });

  app.post('/api/enhance-prompt', async (req: Request, res: Response) => {
    const parsed = enhanceSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const { question, documentName, page } = parsed.data;
    const settings = settingsStore.effective();
    const messages = buildEnhanceMessages({ question, documentName, page });

    let result;
    try {
      result = await callChatCompletion(llmConfigFromEffective(settings), {
        messages,
        temperature: 0.3,
        maxTokens: Math.max(200, Math.min(settings.maxTokens, 800)),
        timeoutMs: 60_000,
      });
    } catch (error) {
      if (error instanceof LlmError) {
        const httpStatus =
          error.status === 429 ? 429 : error.status === 401 || error.status === 403 ? 401 : 502;
        res.status(httpStatus).json({
          error: { code: error.code, message: redactSecrets(error.message, settings.apiKey) },
        });
        return;
      }
      throw error;
    }

    const enhanced = sanitizeEnhancedPrompt(result.content);
    if (!enhanced) {
      res.status(502).json({
        error: {
          code: 'ENHANCE_EMPTY_RESPONSE',
          message: '模型没有返回可用的改写结果，请重试或换一个模型。',
        },
      });
      return;
    }

    res.json({
      enhanced,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
  });

  app.post('/api/ask', async (req: Request, res: Response) => {
    const parsed = askSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const { docId, question } = parsed.data;
    const document = documentStore.get(docId);
    if (!document) {
      res.status(404).json({
        error: {
          code: 'DOCUMENT_NOT_FOUND',
          message: '文档不存在或本地服务已重启。请重新打开 PDF。',
        },
      });
      return;
    }

    const settings = settingsStore.effective();
    const history = trimHistory(parsed.data.history);
    const historyChars = historyCharCount(history);
    const contextBudget = Math.max(1500, settings.contextChars - historyChars);

    const retrieval = retrieve(document.chunks, question, {
      topK: settings.topK,
      contextChars: contextBudget,
      pageCount: document.pageCount,
    });

    const contextInfo = {
      mode: retrieval.mode,
      chunksUsed: retrieval.chunks.length,
      contextChars: retrieval.contextChars,
      pages: retrieval.pages,
      ...(retrieval.requestedPages ? { requestedPages: retrieval.requestedPages } : {}),
      ...(retrieval.requestedChapter ? { requestedChapter: retrieval.requestedChapter } : {}),
      ...(retrieval.note ? { note: retrieval.note } : {}),
    };

    if (retrieval.chunks.length === 0) {
      res.json({
        answer: '未在文档中找到相关内容。',
        citations: [],
        notFound: true,
        context: contextInfo,
      });
      return;
    }

    const messages = buildMessages({
      systemPrompt: settings.systemPrompt,
      chunks: retrieval.chunks,
      question,
      history,
    });

    let result;
    try {
      result = await callChatCompletion(llmConfigFromEffective(settings), { messages });
    } catch (error) {
      if (error instanceof LlmError) {
        const httpStatus =
          error.status === 429 ? 429 : error.status === 401 || error.status === 403 ? 401 : 502;
        res.status(httpStatus).json({
          error: { code: error.code, message: redactSecrets(error.message, settings.apiKey) },
        });
        return;
      }
      throw error;
    }

    const notFound = isNotFoundAnswer(result.content);
    const referencedPages = extractReferencedPages(result.content, document.pageCount);
    let citations = buildCitations(retrieval.chunks, referencedPages, {
      preferredPages: retrieval.requestedPages,
    });
    if (notFound) citations = [];

    res.json({
      answer: result.content,
      citations,
      notFound,
      usage: result.usage,
      latencyMs: result.latencyMs,
      context: contextInfo,
    });
  });

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  });

  if (IS_PRODUCTION) {
    const distDir = path.join(APP_ROOT, 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'GET' && !req.path.startsWith('/api')) {
          res.sendFile(path.join(distDir, 'index.html'));
          return;
        }
        next();
      });
    } else {
      console.warn('[server] 未找到 dist/，请先执行 npm run build。');
    }
  }

  app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof z.ZodError) {
      sendValidationError(res, error);
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof LlmError) {
      res.status(502).json({ error: { code: error.code, message: error.message } });
      return;
    }

    const parseError = error as { type?: string; status?: number };
    if (parseError?.status === 413 || parseError?.type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: '请求体过大（PDF 上限 64MB、文本上限 12MB）。' },
      });
      return;
    }
    if (parseError?.type === 'entity.parse.failed' || parseError?.status === 400) {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是合法 JSON。' } });
      return;
    }

    console.error('[server] 未处理错误:', redactSecrets(error instanceof Error ? error.message : String(error)));
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: '服务端发生未预期错误，请查看服务端日志。' } });
  });

  return app;
}
