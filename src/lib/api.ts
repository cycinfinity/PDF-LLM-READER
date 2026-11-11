import type {
  AskResponse,
  ChatArchive,
  ChatHistoryTurn,
  ChatSummary,
  EnhancePromptResponse,
  PageText,
  PublicSettings,
  SessionRecord,
  SessionState,
  SettingsDraft,
  StoredChatMessage,
  TestConnectionResponse,
  UploadDocumentResponse,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const raw = await response.text();
  let payload: unknown = undefined;
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const body = payload as { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'HTTP_ERROR',
      body?.error?.message ?? raw.slice(0, 300) ?? `请求失败（HTTP ${response.status}）`,
    );
  }

  return payload as T;
}

export function getHealth(): Promise<{ ok: boolean; version: string }> {
  return request('/api/health');
}

export function getSettings(): Promise<PublicSettings> {
  return request('/api/settings');
}

export function saveSettings(draft: SettingsDraft): Promise<PublicSettings> {
  return request('/api/settings', { method: 'PUT', body: JSON.stringify(draft) });
}

export function testConnection(draft?: Partial<SettingsDraft>): Promise<TestConnectionResponse> {
  return request('/api/settings/test', { method: 'POST', body: JSON.stringify(draft ?? {}) });
}

export function uploadDocument(name: string, pages: PageText[]): Promise<UploadDocumentResponse> {
  return request('/api/documents', {
    method: 'POST',
    body: JSON.stringify({ name, pages }),
  });
}

export function updateDocumentPages(
  docId: string,
  pages: PageText[],
): Promise<UploadDocumentResponse> {
  return request(`/api/documents/${encodeURIComponent(docId)}/pages`, {
    method: 'PATCH',
    body: JSON.stringify({ pages }),
  });
}

export function askDocument(
  docId: string,
  question: string,
  history: ChatHistoryTurn[] = [],
): Promise<AskResponse> {
  return request('/api/ask', {
    method: 'POST',
    body: JSON.stringify({ docId, question, history }),
  });
}

/** Rewrites the draft question with the currently configured model. */
export function enhancePrompt(
  question: string,
  options: { documentName?: string; page?: number } = {},
): Promise<EnhancePromptResponse> {
  return request('/api/enhance-prompt', {
    method: 'POST',
    body: JSON.stringify({ question, ...options }),
  });
}

export function deleteDocument(docId: string): Promise<{ ok: boolean }> {
  return request(`/api/documents/${encodeURIComponent(docId)}`, { method: 'DELETE' });
}

async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  const raw = await response.text();
  let payload: unknown = undefined;
  try {
    payload = raw ? JSON.parse(raw) : undefined;
  } catch {
    payload = undefined;
  }
  const body = payload as { error?: { code?: string; message?: string } } | undefined;
  return new ApiError(
    response.status,
    body?.error?.code ?? 'HTTP_ERROR',
    body?.error?.message ?? raw.slice(0, 300) ?? `请求失败（HTTP ${response.status}）`,
  );
}

/** Restores the last opened document after a page refresh (null when none). */
export function getSession(): Promise<SessionState | null> {
  return request('/api/session');
}

export function saveSession(record: Omit<SessionRecord, 'updatedAt'>): Promise<SessionRecord> {
  return request('/api/session', { method: 'PUT', body: JSON.stringify(record) });
}

export function clearSession(): Promise<{ ok: boolean }> {
  return request('/api/session', { method: 'DELETE' });
}

export function getDocument(
  docId: string,
): Promise<{ document: UploadDocumentResponse; pages: PageText[] }> {
  return request(`/api/documents/${encodeURIComponent(docId)}`);
}

/** Uploads the original PDF bytes so the server can restore the file after refresh. */
export async function uploadPdfFile(docId: string, bytes: ArrayBuffer): Promise<{ ok: boolean; size: number }> {
  const response = await fetch(`/api/documents/${encodeURIComponent(docId)}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: bytes,
  });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return (await response.json()) as { ok: boolean; size: number };
}

export async function downloadPdfFile(docId: string): Promise<ArrayBuffer> {
  const response = await fetch(`/api/documents/${encodeURIComponent(docId)}/file`);
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.arrayBuffer();
}

export async function listChats(docId: string): Promise<ChatSummary[]> {
  const result = await request<{ chats: ChatSummary[] }>(
    `/api/documents/${encodeURIComponent(docId)}/chats`,
  );
  return result.chats;
}

export function getChat(docId: string, chatId: string): Promise<ChatArchive> {
  return request(
    `/api/documents/${encodeURIComponent(docId)}/chats/${encodeURIComponent(chatId)}`,
  );
}

export function saveChat(
  docId: string,
  chatId: string,
  messages: StoredChatMessage[],
): Promise<ChatArchive> {
  return request(`/api/documents/${encodeURIComponent(docId)}/chats/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    body: JSON.stringify({ messages }),
  });
}

export function deleteChat(docId: string, chatId: string): Promise<{ ok: boolean; deleted: boolean }> {
  return request(
    `/api/documents/${encodeURIComponent(docId)}/chats/${encodeURIComponent(chatId)}`,
    { method: 'DELETE' },
  );
}

export function friendlyApiError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return '无法连接本地服务（127.0.0.1:8787）。请确认 `npm run dev` 的 api 进程仍在运行。';
  }
  if (error instanceof Error) return error.message;
  return '发生未知错误。';
}
