import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../server/documents';
import { AppError } from '../server/errors';

function pages() {
  return [
    { page: 1, text: '第一页内容，讲相对论。'.repeat(20) },
    { page: 2, text: '第二页内容，讲光速不变。'.repeat(20) },
  ];
}

describe('DocumentStore', () => {
  it('stores page-attributed chunks and returns public info', () => {
    const store = new DocumentStore();
    const info = store.add(' v4.pdf ', pages());

    expect(info.docId).toMatch(/[0-9a-f-]{36}/);
    expect(info.name).toBe('v4.pdf');
    expect(info.pageCount).toBe(2);
    expect(info.charCount).toBeGreaterThan(0);
    expect(info.chunkCount).toBeGreaterThan(0);

    const stored = store.get(info.docId);
    expect(stored).toBeDefined();
    expect(stored!.chunks.length).toBe(info.chunkCount);
    expect(stored!.chunks[0]!.pageStart).toBe(1);
    expect(store.size).toBe(1);

    expect(store.delete(info.docId)).toBe(true);
    expect(store.get(info.docId)).toBeUndefined();
    expect(store.delete(info.docId)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('sorts pages before building chunks', () => {
    const store = new DocumentStore();
    const info = store.add('unsorted.pdf', [
      { page: 2, text: '第二页文字。'.repeat(30) },
      { page: 1, text: '第一页文字。'.repeat(30) },
    ]);
    const stored = store.get(info.docId)!;
    expect(stored.chunks[0]!.pageStart).toBe(1);
  });

  it('truncates very long names', () => {
    const store = new DocumentStore();
    const info = store.add('x'.repeat(400), pages());
    expect(info.name.length).toBe(300);
  });

  it('rejects documents without a text layer', () => {
    const store = new DocumentStore();
    let caught: unknown;
    try {
      store.add('scan.pdf', [{ page: 1, text: '   ' }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(422);
    expect((caught as AppError).code).toBe('NO_TEXT_LAYER');
    expect(store.size).toBe(0);
  });

  it('rejects documents above the character limit', () => {
    const store = new DocumentStore();
    let caught: unknown;
    try {
      store.add('huge.pdf', [{ page: 1, text: 'a'.repeat(2_000_001) }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(413);
    expect((caught as AppError).code).toBe('DOCUMENT_TOO_LARGE');
  });
});

describe('DocumentStore.updatePages', () => {
  it('replaces a subset of page text and rebuilds the index', () => {
    const store = new DocumentStore();
    const info = store.add('v4.pdf', pages());

    const updated = store.updatePages(info.docId, [
      { page: 2, text: '量子纠缠与贝尔不等式的新内容。'.repeat(20) },
    ]);

    expect(updated.pageCount).toBe(2);
    expect(updated.charCount).not.toBe(info.charCount);
    const stored = store.get(info.docId)!;
    expect(stored.pages.find((page) => page.page === 2)!.text).toContain('量子纠缠');
    expect(stored.chunks.some((chunk) => chunk.text.includes('量子纠缠'))).toBe(true);
    expect(stored.chunks.some((chunk) => chunk.text.includes('光速不变'))).toBe(false);
  });

  it('rejects unknown documents', () => {
    const store = new DocumentStore();
    let caught: unknown;
    try {
      store.updatePages('missing', [{ page: 1, text: 'x'.repeat(50) }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(404);
    expect((caught as AppError).code).toBe('DOCUMENT_NOT_FOUND');
  });

  it('rejects page numbers outside the document', () => {
    const store = new DocumentStore();
    const info = store.add('v4.pdf', pages());
    let caught: unknown;
    try {
      store.updatePages(info.docId, [{ page: 3, text: 'x'.repeat(50) }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(400);
    expect((caught as AppError).code).toBe('PAGE_OUT_OF_RANGE');
  });

  it('rejects updates that exceed the character limit', () => {
    const store = new DocumentStore();
    const info = store.add('v4.pdf', pages());
    let caught: unknown;
    try {
      store.updatePages(info.docId, [{ page: 1, text: 'a'.repeat(2_000_001) }]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(413);
    expect((caught as AppError).code).toBe('DOCUMENT_TOO_LARGE');
  });

  it('clears chunks when every page is updated to blank text', () => {
    const store = new DocumentStore();
    const info = store.add('v4.pdf', pages());
    const updated = store.updatePages(info.docId, [
      { page: 1, text: '' },
      { page: 2, text: '  ' },
    ]);
    expect(updated.charCount).toBe(0);
    expect(updated.chunkCount).toBe(0);
    expect(store.get(info.docId)!.chunks).toEqual([]);
  });
});

describe('DocumentStore persistence', () => {
  it('writes page texts + PDF bytes and reloads them after a restart', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-llm-library-'));
    try {
      const store = new DocumentStore(dir);
      const info = store.add('relativity.pdf', pages());
      store.savePdf(info.docId, Buffer.from('%PDF-1.4\n% test\n%%EOF\n'));

      const restarted = new DocumentStore(dir);
      expect(restarted.loadFromDisk()).toBe(1);
      expect(restarted.get(info.docId)?.name).toBe('relativity.pdf');
      expect(restarted.get(info.docId)?.pages).toHaveLength(2);
      expect(restarted.get(info.docId)?.chunks.length).toBeGreaterThan(0);
      expect(restarted.getPdfPath(info.docId)).toContain(`${info.docId}.pdf`);

      restarted.delete(info.docId);
      expect(fs.existsSync(path.join(dir, `${info.docId}.json`))).toBe(false);
      expect(fs.existsSync(path.join(dir, `${info.docId}.pdf`))).toBe(false);
      expect(new DocumentStore(dir).loadFromDisk()).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
