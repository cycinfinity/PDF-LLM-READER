export interface PageText {
  page: number;
  text: string;
}

export interface UploadDocumentResponse {
  docId: string;
  name: string;
  pageCount: number;
  charCount: number;
  chunkCount: number;
  createdAt: string;
}

export type ApiKeySource = 'none' | 'settings' | 'env';

export interface PublicSettings {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  topK: number;
  contextChars: number;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  apiKeySource: ApiKeySource;
}

export interface SettingsDraft {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  topK: number;
  contextChars: number;
  /** Omit or pass an empty string to keep the stored key. */
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface Citation {
  page: number;
  pageEnd: number;
  snippet: string;
  chunkId: number;
}

export type AskContextMode = 'full' | 'retrieval' | 'summary' | 'pages' | 'chapter';

export interface AskContextInfo {
  mode: AskContextMode;
  chunksUsed: number;
  contextChars: number;
  pages: number[];
  /** Pages explicitly requested by the question (page-focused mode). */
  requestedPages?: number[];
  /** Chapter/section label explicitly requested by the question. */
  requestedChapter?: string;
  /** Fallback/truncation explanation shown under the answer. */
  note?: string;
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  notFound: boolean;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  context: AskContextInfo;
  latencyMs?: number;
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  notFound?: boolean;
  error?: boolean;
  contextInfo?: AskContextInfo;
}

export interface TestConnectionResponse {
  ok: boolean;
  latencyMs?: number;
  model?: string;
  error?: string;
}

/** Result of rewriting the current draft into a clearer prompt. */
export interface EnhancePromptResponse {
  enhanced: string;
  model: string;
  latencyMs: number;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

/** Snapshot of the last opened document + view state, stored server-side. */
export interface SessionRecord {
  docId: string;
  page: number;
  zoom: number;
  fitWidth: boolean;
  updatedAt: string;
}

export interface SessionState extends SessionRecord {
  document: UploadDocumentResponse;
  pages: PageText[];
}

export interface StoredChatMessage extends ChatMessage {
  createdAt?: string;
}

export interface ChatArchive {
  id: string;
  docId: string;
  title: string;
  messages: StoredChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  messageCount: number;
  preview: string;
  createdAt: string;
  updatedAt: string;
}
