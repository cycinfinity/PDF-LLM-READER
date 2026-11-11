import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';

/**
 * Small JSON-file stores used for "reopen the last PDF" and chat archives.
 * Everything lives under DATA_DIR (default: <project>/data), so deleting that
 * folder is the documented way to reset all local state.
 */

export interface SessionRecord {
  docId: string;
  page: number;
  zoom: number;
  fitWidth: boolean;
  updatedAt: string;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampZoom(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(2, Math.max(0.5, parsed));
}

export class SessionStore {
  constructor(private readonly filePath: string) {}

  get(): SessionRecord | null {
    const parsed = readJson<Partial<SessionRecord>>(this.filePath);
    if (!parsed || typeof parsed.docId !== 'string' || parsed.docId.length === 0) return null;
    return {
      docId: parsed.docId,
      page: clampInt(parsed.page, 1, 1, 100_000),
      zoom: clampZoom(parsed.zoom),
      fitWidth: parsed.fitWidth !== false,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  }

  save(record: Omit<SessionRecord, 'updatedAt'>): SessionRecord {
    const stored: SessionRecord = { ...record, updatedAt: new Date().toISOString() };
    writeJsonAtomic(this.filePath, stored);
    return stored;
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // best effort
    }
  }
}

export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: unknown[];
  notFound?: boolean;
  contextInfo?: unknown;
  createdAt: string;
}

export interface ChatArchive {
  /** Conversation id (one JSON file per conversation). */
  id: string;
  docId: string;
  /** Derived from the first user message; shown in the history menu. */
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

const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function assertId(value: string, code: string, label: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new AppError(400, code, `${label}不合法。`);
  }
  return value;
}

function messagePreview(messages: StoredChatMessage[]): string {
  const last = [...messages].reverse().find((message) => message.content.trim().length > 0);
  if (!last) return '';
  return last.content.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function conversationTitle(messages: StoredChatMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!firstUser) return '新对话';
  const title = firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 40);
  return title || '新对话';
}

export class ChatStore {
  constructor(private readonly dir: string) {
    ensureDir(dir);
  }

  private docDir(docId: string): string {
    assertId(docId, 'INVALID_DOCUMENT_ID', '文档 ID ');
    return path.join(this.dir, docId);
  }

  private filePath(docId: string, chatId: string): string {
    assertId(docId, 'INVALID_DOCUMENT_ID', '文档 ID ');
    assertId(chatId, 'INVALID_CHAT_ID', '对话 ID ');
    return path.join(this.dir, docId, `${chatId}.json`);
  }

  /** Old versions stored one chat per document at `<dir>/<docId>.json`. */
  private legacyPath(docId: string): string {
    assertId(docId, 'INVALID_DOCUMENT_ID', '文档 ID ');
    return path.join(this.dir, `${docId}.json`);
  }

  private migrateLegacy(docId: string): void {
    const legacy = this.legacyPath(docId);
    if (!fs.existsSync(legacy)) return;
    const parsed = readJson<Partial<ChatArchive>>(legacy);
    if (!parsed || !Array.isArray(parsed.messages)) {
      fs.rmSync(legacy, { force: true });
      return;
    }
    const chatId = 'legacy';
    const archive: ChatArchive = {
      id: chatId,
      docId,
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : conversationTitle(parsed.messages),
      messages: parsed.messages as StoredChatMessage[],
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
    writeJsonAtomic(path.join(this.dir, docId, `${chatId}.json`), archive);
    fs.rmSync(legacy, { force: true });
  }

  list(docId: string): ChatSummary[] {
    const dir = this.docDir(docId);
    this.migrateLegacy(docId);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const summaries: ChatSummary[] = [];
    for (const name of names) {
      const archive = readJson<ChatArchive>(path.join(dir, name));
      if (!archive || !Array.isArray(archive.messages)) continue;
      const id = typeof archive.id === 'string' ? archive.id : name.replace(/\.json$/, '');
      summaries.push({
        id,
        title: typeof archive.title === 'string' && archive.title ? archive.title : conversationTitle(archive.messages),
        messageCount: archive.messages.length,
        preview: messagePreview(archive.messages),
        createdAt: typeof archive.createdAt === 'string' ? archive.createdAt : typeof archive.updatedAt === 'string' ? archive.updatedAt : new Date().toISOString(),
        updatedAt: typeof archive.updatedAt === 'string' ? archive.updatedAt : new Date().toISOString(),
      });
    }
    summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return summaries;
  }

  get(docId: string, chatId: string): ChatArchive | null {
    this.migrateLegacy(docId);
    const parsed = readJson<ChatArchive>(this.filePath(docId, chatId));
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return {
      ...parsed,
      id: typeof parsed.id === 'string' ? parsed.id : chatId,
      docId,
      title: typeof parsed.title === 'string' && parsed.title ? parsed.title : conversationTitle(parsed.messages),
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  }

  save(
    docId: string,
    chatId: string,
    messages: Array<Omit<StoredChatMessage, 'createdAt'> & { createdAt?: string }>,
  ): ChatArchive {
    const filePath = this.filePath(docId, chatId);
    const previous = readJson<ChatArchive>(filePath);
    const now = new Date().toISOString();
    const archive: ChatArchive = {
      id: chatId,
      docId,
      title: conversationTitle(messages as StoredChatMessage[]),
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        ...(message.citations ? { citations: message.citations } : {}),
        ...(message.notFound !== undefined ? { notFound: message.notFound } : {}),
        ...(message.contextInfo !== undefined ? { contextInfo: message.contextInfo } : {}),
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : now,
      })),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    writeJsonAtomic(filePath, archive);
    return archive;
  }

  delete(docId: string, chatId: string): boolean {
    const filePath = this.filePath(docId, chatId);
    try {
      if (!fs.existsSync(filePath)) return false;
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  deleteAll(docId: string): void {
    try {
      fs.rmSync(this.docDir(docId), { recursive: true, force: true });
    } catch {
      // best effort
    }
    try {
      fs.rmSync(this.legacyPath(docId), { force: true });
    } catch {
      // best effort
    }
  }
}
