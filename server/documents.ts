import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildChunks, type PageText, type TextChunk } from './chunk';
import { AppError } from './errors';

export interface StoredDocument {
  id: string;
  name: string;
  pageCount: number;
  charCount: number;
  chunkCount: number;
  pages: PageText[];
  chunks: TextChunk[];
  createdAt: string;
}

export interface DocumentInfo {
  docId: string;
  name: string;
  pageCount: number;
  charCount: number;
  chunkCount: number;
  createdAt: string;
}

export const DOCUMENT_LIMITS = {
  maxPages: 500,
  maxChars: 2_000_000,
  maxNameLength: 300,
} as const;

export function toDocumentInfo(document: StoredDocument): DocumentInfo {
  return {
    docId: document.id,
    name: document.name,
    pageCount: document.pageCount,
    charCount: document.charCount,
    chunkCount: document.chunkCount,
    createdAt: document.createdAt,
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export class DocumentStore {
  private readonly documents = new Map<string, StoredDocument>();

  /** When set, every mutation is also written to `<dir>/<docId>.json` so a
   * restart can restore the last document, and `<docId>.pdf` keeps the bytes. */
  constructor(private readonly libraryDir?: string) {
    if (libraryDir) fs.mkdirSync(libraryDir, { recursive: true, mode: 0o700 });
  }

  private documentPath(id: string): string {
    return path.join(this.libraryDir ?? '', `${id}.json`);
  }

  private pdfPath(id: string): string {
    return path.join(this.libraryDir ?? '', `${id}.pdf`);
  }

  private persist(document: StoredDocument): void {
    if (!this.libraryDir) return;
    writeJsonAtomic(this.documentPath(document.id), {
      id: document.id,
      name: document.name,
      pageCount: document.pageCount,
      charCount: document.charCount,
      chunkCount: document.chunkCount,
      pages: document.pages,
      createdAt: document.createdAt,
    });
  }

  /** Loads persisted document text from disk (called once at startup). */
  loadFromDisk(): number {
    if (!this.libraryDir || !fs.existsSync(this.libraryDir)) return 0;
    let loaded = 0;
    for (const entry of fs.readdirSync(this.libraryDir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(this.libraryDir, entry), 'utf8')) as {
          id?: string;
          name?: string;
          pages?: PageText[];
          createdAt?: string;
        };
        if (!parsed.id || !parsed.name || !Array.isArray(parsed.pages) || parsed.pages.length === 0) {
          continue;
        }
        const pages = [...parsed.pages]
          .filter((page) => Number.isInteger(page.page) && typeof page.text === 'string')
          .sort((a, b) => a.page - b.page);
        if (pages.length === 0) continue;
        const charCount = pages.reduce((sum, page) => sum + page.text.trim().length, 0);
        if (charCount < 20) continue;
        const chunks = buildChunks(pages);
        if (chunks.length === 0) continue;
        this.documents.set(parsed.id, {
          id: parsed.id,
          name: parsed.name,
          pageCount: pages.length,
          charCount,
          chunkCount: chunks.length,
          pages,
          chunks,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
        });
        loaded += 1;
      } catch {
        // Ignore unreadable or partially-written library files.
      }
    }
    return loaded;
  }

  add(name: string, pages: PageText[]): DocumentInfo {
    const sorted = [...pages].sort((a, b) => a.page - b.page);
    const charCount = sorted.reduce((sum, page) => sum + page.text.trim().length, 0);

    if (charCount < 20) {
      throw new AppError(
        422,
        'NO_TEXT_LAYER',
        '该 PDF 没有可提取的文字层（可能是扫描件）。请等待自动 OCR，或点击「识别此页」后再提问。',
      );
    }
    if (charCount > DOCUMENT_LIMITS.maxChars) {
      throw new AppError(
        413,
        'DOCUMENT_TOO_LARGE',
        `文本超过 ${DOCUMENT_LIMITS.maxChars.toLocaleString('en-US')} 字符上限，请拆分 PDF 后再试。`,
      );
    }

    const chunks = buildChunks(sorted);
    if (chunks.length === 0) {
      throw new AppError(
        422,
        'NO_TEXT_LAYER',
        '该 PDF 没有可提取的文字层（可能是扫描件）。请等待自动 OCR，或点击「识别此页」后再提问。',
      );
    }

    const document: StoredDocument = {
      id: randomUUID(),
      name: name.trim().slice(0, DOCUMENT_LIMITS.maxNameLength),
      pageCount: sorted.length,
      charCount,
      chunkCount: chunks.length,
      pages: sorted,
      chunks,
      createdAt: new Date().toISOString(),
    };
    this.documents.set(document.id, document);
    this.persist(document);

    return toDocumentInfo(document);
  }

  /**
   * Replace the text for a subset of pages (used by OCR / manual corrections).
   * Rebuilds the lexical index so later questions see the updated content.
   */
  updatePages(id: string, updates: PageText[]): DocumentInfo {
    const document = this.documents.get(id);
    if (!document) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', '文档不存在或本地服务已重启。请重新打开 PDF。');
    }

    const pagesByNumber = new Map(document.pages.map((page) => [page.page, page]));
    for (const update of updates) {
      if (update.page < 1 || update.page > document.pageCount) {
        throw new AppError(
          400,
          'PAGE_OUT_OF_RANGE',
          `页码 ${update.page} 超出文档范围（1-${document.pageCount}）。`,
        );
      }
      pagesByNumber.set(update.page, { page: update.page, text: update.text });
    }

    const pages = [...pagesByNumber.values()].sort((a, b) => a.page - b.page);
    const charCount = pages.reduce((sum, page) => sum + page.text.trim().length, 0);
    if (charCount > DOCUMENT_LIMITS.maxChars) {
      throw new AppError(
        413,
        'DOCUMENT_TOO_LARGE',
        `文本超过 ${DOCUMENT_LIMITS.maxChars.toLocaleString('en-US')} 字符上限，请拆分 PDF 后再试。`,
      );
    }

    document.pages = pages;
    document.charCount = charCount;
    document.chunks = charCount >= 20 ? buildChunks(pages) : [];
    document.chunkCount = document.chunks.length;
    this.persist(document);

    return toDocumentInfo(document);
  }

  /** Saves the original PDF bytes so the UI can restore the document after a
   * browser refresh (the browser no longer keeps the file). */
  savePdf(id: string, bytes: Buffer): void {
    const document = this.documents.get(id);
    if (!document) {
      throw new AppError(404, 'DOCUMENT_NOT_FOUND', '文档不存在或本地服务已重启。请重新打开 PDF。');
    }
    if (!this.libraryDir) return;
    const tempPath = `${this.pdfPath(id)}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, bytes, { mode: 0o600 });
    fs.renameSync(tempPath, this.pdfPath(id));
  }

  getPdfPath(id: string): string | null {
    if (!this.libraryDir) return null;
    const filePath = this.pdfPath(id);
    return fs.existsSync(filePath) ? filePath : null;
  }

  getPages(id: string): PageText[] | null {
    const document = this.documents.get(id);
    return document ? document.pages : null;
  }

  get(id: string): StoredDocument | undefined {
    return this.documents.get(id);
  }

  delete(id: string): boolean {
    const deleted = this.documents.delete(id);
    if (this.libraryDir) {
      try {
        fs.rmSync(this.documentPath(id), { force: true });
        fs.rmSync(this.pdfPath(id), { force: true });
      } catch {
        // best effort
      }
    }
    return deleted;
  }

  get size(): number {
    return this.documents.size;
  }
}
