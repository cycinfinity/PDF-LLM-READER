import { AlertTriangle, FilePlus2, Loader2, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { ExportDialog } from './components/ExportDialog';
import { OcrPanel } from './components/OcrPanel';
import { PdfViewer } from './components/PdfViewer';
import { SettingsDialog } from './components/SettingsDialog';
import { Toolbar } from './components/Toolbar';
import {
  askDocument,
  clearSession,
  deleteChat,
  downloadPdfFile,
  friendlyApiError,
  getChat,
  getSession,
  getSettings,
  listChats,
  saveChat,
  saveSession,
  updateDocumentPages,
  uploadDocument,
  uploadPdfFile,
} from './lib/api';
import { extractPageTexts, loadPdf, type PDFDocumentProxy } from './lib/pdf';
import {
  disposeOcrWorker,
  ocrPdfPage,
  type OcrLanguage,
  type OcrPageResult,
  type OcrStage,
} from './lib/ocr';
import type {
  ChatArchive,
  ChatMessage,
  ChatSummary,
  PageText,
  PublicSettings,
  SessionState,
  StoredChatMessage,
  UploadDocumentResponse,
} from './lib/types';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const SIDEBAR_WIDTH_KEY = 'pdf-reader:sidebar-width';
const SIDEBAR_OPEN_KEY = 'pdf-reader:sidebar-open';
const DEFAULT_SIDEBAR_WIDTH = 400;

function clampSidebarWidth(width: number): number {
  return Math.min(760, Math.max(300, Math.round(width)));
}

function readSidebarWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function readSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

// 本机 OpenAI 兼容服务（Ollama/LM Studio/llama.cpp 等）通常不校验 API Key，
// 允许这类 baseUrl 在 Key 为空时直接提问。
function canUseModelWithoutKey(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

type IndexStage = 'reading' | 'extracting' | 'indexing';

interface IndexingState {
  stage: IndexStage;
  done: number;
  total: number;
}

function indexingLabel(state: IndexingState | null): string | null {
  if (!state) return null;
  if (state.stage === 'reading') return '读取文件…';
  if (state.stage === 'extracting') return `提取文本 ${state.done}/${state.total}`;
  return '建立索引…';
}

function EmptyState({ onOpenFile }: { onOpenFile: () => void }) {
  return (
    <div
      data-testid="empty-state"
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-8"
    >
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
          <UploadCloud size={28} />
        </div>
        <h1 className="text-lg font-semibold text-slate-900">打开一份 PDF，开始文档内问答</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-500">
          支持打开本地 PDF 并提问。答案只依据文档内容，并附可点击的页码引用。
        </p>
        <button
          type="button"
          data-testid="empty-open-file"
          onClick={onOpenFile}
          className="mt-5 inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <FilePlus2 size={16} />
          选择 PDF 文件
        </button>
        <p className="mt-3 text-[11px] text-slate-400">也可以直接把 PDF 拖到这里</p>
        <div className="mt-6 grid gap-2 border-t border-slate-100 pt-4 text-left text-[11px] leading-relaxed text-slate-400">
          <p>· PDF 字节只留在浏览器，只有提取出的页文本会发送到本地服务（127.0.0.1:8787）。</p>
          <p>· 扫描件会自动 OCR 当前页；识别文本可编辑，并可导出带文字层的文本 PDF。</p>
          <p>· 首次使用请先在「设置」中配置 LLM 服务商与 API Key（Ollama 等本机服务可留空 Key）。</p>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);

  const [pageTexts, setPageTexts] = useState<PageText[]>([]);
  const [needsOcr, setNeedsOcr] = useState(false);
  const [ocrPanelOpen, setOcrPanelOpen] = useState(false);
  const [ocrLanguage, setOcrLanguage] = useState<OcrLanguage>('eng');
  const [autoOcr, setAutoOcr] = useState(true);
  const [ocrBusy, setOcrBusy] = useState<{ page: number; stage: OcrStage; progress: number } | null>(
    null,
  );
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrResults, setOcrResults] = useState<Map<number, OcrPageResult>>(new Map());
  const [exportOpen, setExportOpen] = useState(false);

  const [indexing, setIndexing] = useState<IndexingState | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [savingIndex, setSavingIndex] = useState(false);
  const [docInfo, setDocInfo] = useState<UploadDocumentResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [asking, setAsking] = useState(false);
  const [chatArchived, setChatArchived] = useState(false);
  // Each page load / new document starts a fresh conversation. Archives are
  // kept per conversation under DATA_DIR/chats/<docId>/<conversationId>.json.
  const [conversationId, setConversationId] = useState<string>(() => crypto.randomUUID());
  const [chatHistory, setChatHistory] = useState<ChatSummary[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewingHistory, setViewingHistory] = useState<ChatArchive | null>(null);
  // True while the current PDF was restored from the server session. The saved
  // page texts are not proof of a native text layer, so the OCR panel must not
  // label them as one.
  const [restoredSession, setRestoredSession] = useState(false);

  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadTokenRef = useRef(0);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const pdfDocRef = useRef<PDFDocumentProxy | null>(null);
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);
  const pageCountRef = useRef(0);
  const pageTextsRef = useRef<PageText[]>([]);
  const docInfoRef = useRef<UploadDocumentResponse | null>(null);
  const ocrResultsRef = useRef<Map<number, OcrPageResult>>(new Map());
  const ocrLockRef = useRef(false);
  const autoAttemptedRef = useRef<Set<number>>(new Set());
  const editTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((error) => {
        if (!cancelled) setNotice(`读取设置失败：${friendlyApiError(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      // localStorage may be unavailable in private mode; resizing still works for the session.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0');
    } catch {
      // ignore
    }
  }, [sidebarOpen]);

  useEffect(() => {
    return () => {
      if (editTimerRef.current) window.clearTimeout(editTimerRef.current);
      void disposeOcrWorker();
      void pdfDocRef.current?.loadingTask.destroy();
    };
  }, []);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const applyDocInfo = useCallback((info: UploadDocumentResponse | null) => {
    docInfoRef.current = info;
    setDocInfo(info);
  }, []);

  const refreshChatHistory = useCallback(async (docId: string): Promise<void> => {
    setHistoryLoading(true);
    try {
      setChatHistory(await listChats(docId));
    } catch {
      // History is a convenience; reading and the current conversation keep working.
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  /** Saves the original PDF bytes so the server can restore the file after refresh. */
  const persistPdfBytes = useCallback(async (info: UploadDocumentResponse): Promise<void> => {
    const bytes = pdfBytesRef.current;
    if (!bytes) return;
    try {
      await uploadPdfFile(info.docId, bytes);
    } catch (error) {
      setNotice(`索引已建立，但保存 PDF 原文件失败：${friendlyApiError(error)}（刷新后可能无法恢复）`);
    }
  }, []);

  // Persist view position so a page refresh restores the document at the same page.
  useEffect(() => {
    if (!docInfo) return;
    const timer = window.setTimeout(() => {
      void saveSession({
        docId: docInfo.docId,
        page: currentPage,
        zoom,
        fitWidth,
      }).catch(() => {
        // Session persistence is best-effort; reading keeps working without it.
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [docInfo, currentPage, zoom, fitWidth]);

  // Persist the current conversation under its own id; an empty conversation
  // does not create a file, and old conversations are never overwritten.
  useEffect(() => {
    if (!docInfo || messages.length === 0) return;
    const timer = window.setTimeout(() => {
      const stored: StoredChatMessage[] = messages
        .filter((message) => !message.error)
        .map((message) => ({ ...message, createdAt: new Date().toISOString() }));
      if (stored.length === 0) return;
      void saveChat(docInfo.docId, conversationId, stored)
        .then(() => {
          setChatArchived(true);
          void refreshChatHistory(docInfo.docId);
        })
        .catch(() => setChatArchived(false));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [docInfo, messages, conversationId, refreshChatHistory]);

  // Keep the history menu in sync whenever the active document changes.
  useEffect(() => {
    if (!docInfo) {
      setChatHistory([]);
      return;
    }
    void refreshChatHistory(docInfo.docId);
  }, [docInfo, refreshChatHistory]);

  // Restore the last opened document (bytes, page texts, position, chat) on page load.
  useEffect(() => {
    let cancelled = false;
    const token = ++loadTokenRef.current;

    const restore = async () => {
      let session: SessionState | null = null;
      try {
        session = await getSession();
      } catch (error) {
        if (!cancelled && token === loadTokenRef.current) {
          setNotice(`读取上次阅读记录失败：${friendlyApiError(error)}`);
        }
        return;
      }
      if (!session) return;
      if (cancelled || token !== loadTokenRef.current) return;

      setIndexing({ stage: 'reading', done: 0, total: 0 });
      try {
        const bytes = await downloadPdfFile(session.docId);
        const doc = await loadPdf(bytes);
        if (cancelled || token !== loadTokenRef.current) {
          void doc.loadingTask.destroy();
          return;
        }
        pdfDocRef.current = doc;
        pdfBytesRef.current = bytes;
        setPdfDoc(doc);
        setPdfBytes(bytes);
        setFileName(session.document.name);
        pageCountRef.current = session.document.pageCount;
        setPageCount(session.document.pageCount);
        pageTextsRef.current = session.pages;
        setPageTexts(session.pages);
        applyDocInfo(session.document);
        const page = Math.min(Math.max(1, session.page), session.document.pageCount);
        setCurrentPage(page);
        setZoom(Math.min(2, Math.max(0.5, session.zoom)));
        setFitWidth(session.fitWidth);
        const blankPages = session.pages.filter((item) => item.text.trim().length === 0).length;
        setNeedsOcr(blankPages > 0);
        if (blankPages > 0) setOcrPanelOpen(true);

        // Start a fresh conversation on every page load. The previous
        // conversation stays in the history list and is never resumed.
        setConversationId(crypto.randomUUID());
        setMessages([]);
        setChatArchived(false);
        setViewingHistory(null);
        setHistoryOpen(false);
        setNotice(
          `已恢复上次打开的 PDF「${session.document.name}」· 第 ${page} / ${session.document.pageCount} 页。已开启新对话，上一段对话保留在历史记录中。`,
        );
        setRestoredSession(true);
      } catch (error) {
        if (!cancelled && token === loadTokenRef.current) {
          setNotice(`恢复上次打开的 PDF 失败：${friendlyApiError(error)}`);
          void clearSession().catch(() => {});
        }
      } finally {
        if (!cancelled && token === loadTokenRef.current) setIndexing(null);
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, [applyDocInfo]);

  const setPageTextContent = useCallback((page: number, text: string) => {
    const total = Math.max(pageCountRef.current, page);
    const next = pageTextsRef.current.slice();
    while (next.length < total) next.push({ page: next.length + 1, text: '' });
    next[page - 1] = { page, text };
    pageTextsRef.current = next;
    setPageTexts(next);
  }, []);

  /**
   * Push page text to the local server index. The first successful call
   * uploads the whole document; later calls PATCH only the changed pages.
   * Returns silently when there is not enough text to index yet.
   */
  const persistPageTexts = useCallback(
    async (allPages: PageText[], changed?: PageText[]): Promise<void> => {
      const existing = docInfoRef.current;
      if (existing && changed && changed.length > 0) {
        setSavingIndex(true);
        try {
          const info = await updateDocumentPages(existing.docId, changed);
          applyDocInfo(info);
        } catch (error) {
          setNotice(`索引更新失败：${friendlyApiError(error)}`);
        } finally {
          setSavingIndex(false);
        }
        return;
      }

      if (!existing) {
        const charCount = allPages.reduce(
          (sum, page) => sum + page.text.replace(/\s/g, '').length,
          0,
        );
        if (charCount < 20) return;
        setSavingIndex(true);
        try {
          const info = await uploadDocument(fileName ?? 'document.pdf', allPages);
          applyDocInfo(info);
          void persistPdfBytes(info);
          const textPages = allPages.filter((page) => page.text.trim().length > 0).length;
          setNotice(
            `已索引 ${textPages} 页文字 · ${info.charCount.toLocaleString()} 字符 · ${info.chunkCount} 个片段，可以开始提问。`,
          );
        } catch (error) {
          const message = friendlyApiError(error);
          if (!message.includes('没有可提取的文字层')) {
            setNotice(`建立问答索引失败：${message}`);
          }
        } finally {
          setSavingIndex(false);
        }
      }
    },
    [applyDocInfo, fileName, persistPdfBytes],
  );

  const runOcrPage = useCallback(
    async (page: number): Promise<void> => {
      if (!pdfDoc || ocrLockRef.current) return;
      ocrLockRef.current = true;
      setOcrError(null);
      setOcrBusy({ page, stage: 'rendering', progress: 0 });
      try {
        const result = await ocrPdfPage(pdfDoc, page, ocrLanguage, (progress) => {
          setOcrBusy({ page, stage: progress.stage, progress: progress.progress });
        });
        ocrResultsRef.current.set(page, result);
        setOcrResults(new Map(ocrResultsRef.current));
        setPageTextContent(page, result.ocrText);
        const chars = result.ocrText.replace(/\s/g, '').length;
        setNotice(
          `第 ${page} 页 OCR 完成 · 平均置信度 ${result.confidence.toFixed(1)} · ${chars} 字符${
            result.confidence >= 80 ? '（高准确度）' : '（建议在 OCR 面板中校正）'
          }。`,
        );
        await persistPageTexts(pageTextsRef.current, [{ page, text: result.ocrText }]);
      } catch (error) {
        setOcrError(`第 ${page} 页 OCR 失败：${friendlyApiError(error)}`);
      } finally {
        ocrLockRef.current = false;
        setOcrBusy(null);
      }
    },
    [pdfDoc, ocrLanguage, persistPageTexts, setPageTextContent],
  );

  // Automatically OCR the current page when the document has no text layer (or
  // when the current page is blank in a partially scanned document).
  useEffect(() => {
    if (!pdfDoc || !needsOcr || !autoOcr || ocrLockRef.current || ocrBusy) return;
    if (autoAttemptedRef.current.has(currentPage)) return;
    const text = pageTextsRef.current[currentPage - 1]?.text?.trim();
    if (text) return;
    if (ocrResultsRef.current.has(currentPage)) return;
    autoAttemptedRef.current.add(currentPage);
    void runOcrPage(currentPage);
  }, [pdfDoc, needsOcr, autoOcr, currentPage, ocrBusy, pageTexts, runOcrPage]);

  const handleFile = useCallback(
    async (file: File) => {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        setNotice('请选择 PDF 文件。');
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        setNotice('PDF 超过 100MB，当前版本无法处理。');
        return;
      }

      const token = loadTokenRef.current + 1;
      loadTokenRef.current = token;
      void disposeOcrWorker();
      if (pdfDocRef.current) void pdfDocRef.current.loadingTask.destroy();

      setIndexError(null);
      applyDocInfo(null);
      setRestoredSession(false);
      setMessages([]);
      setChatArchived(false);
      setConversationId(crypto.randomUUID());
      setChatHistory([]);
      setViewingHistory(null);
      setHistoryOpen(false);
      setFileName(file.name);
      setPdfDoc(null);
      pdfDocRef.current = null;
      setPdfBytes(null);
      pdfBytesRef.current = null;
      setPageCount(0);
      pageCountRef.current = 0;
      setCurrentPage(1);
      setPageTexts([]);
      pageTextsRef.current = [];
      setNeedsOcr(false);
      setOcrResults(new Map());
      ocrResultsRef.current = new Map();
      setOcrError(null);
      setOcrPanelOpen(false);
      autoAttemptedRef.current.clear();
      setExportOpen(false);
      setIndexing({ stage: 'reading', done: 0, total: 0 });

      try {
        const buffer = await file.arrayBuffer();
        const originalBytes = buffer.slice(0);
        const doc = await loadPdf(buffer);
        if (token !== loadTokenRef.current) {
          void doc.loadingTask.destroy();
          return;
        }
        pdfDocRef.current = doc;
        pdfBytesRef.current = originalBytes;
        setPdfBytes(originalBytes);
        setPdfDoc(doc);
        pageCountRef.current = doc.numPages;
        setPageCount(doc.numPages);
        setCurrentPage(1);
        setIndexing({ stage: 'extracting', done: 0, total: doc.numPages });

        const pages = await extractPageTexts(doc, (done, total) => {
          if (token === loadTokenRef.current) {
            setIndexing({ stage: 'extracting', done, total });
          }
        });
        if (token !== loadTokenRef.current) return;

        pageTextsRef.current = pages;
        setPageTexts(pages);
        const readablePages = pages.filter((page) => page.text.trim().length > 0).length;
        const hasBlankPages = readablePages < pages.length;
        setNeedsOcr(hasBlankPages);

        if (readablePages === 0) {
          setOcrPanelOpen(true);
          setNotice('检测到扫描件（无文字层），已开启自动 OCR：正在识别当前页…');
          return;
        }

        if (readablePages < pages.length) {
          setOcrPanelOpen(true);
          setNotice(`该 PDF 有 ${pages.length - readablePages} 页没有文字层；翻到这些页面会自动 OCR。`);
        }

        setIndexing({ stage: 'indexing', done: pages.length, total: pages.length });
        const info = await uploadDocument(file.name, pages);
        if (token !== loadTokenRef.current) return;

        applyDocInfo(info);
        void persistPdfBytes(info);
        setNotice(
          `已索引 ${info.pageCount} 页 · ${info.charCount.toLocaleString()} 字符 · ${info.chunkCount} 个片段，可以开始提问。`,
        );
      } catch (error) {
        if (token !== loadTokenRef.current) return;
        setIndexError(friendlyApiError(error));
      } finally {
        if (token === loadTokenRef.current) setIndexing(null);
      }
    },
    [applyDocInfo],
  );

  const ask = useCallback(
    async (question: string) => {
      if (!docInfo || asking) return;

      const history = messages
        .filter((message) => !message.error)
        .slice(-6)
        .map((message) => ({ role: message.role, content: message.content }));

      setMessages((previous) => [
        ...previous,
        { id: crypto.randomUUID(), role: 'user', content: question },
      ]);
      setAsking(true);

      try {
        const response = await askDocument(docInfo.docId, question, history);
        setMessages((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: response.answer,
            citations: response.citations,
            notFound: response.notFound,
            contextInfo: response.context,
          },
        ]);
      } catch (error) {
        setMessages((previous) => [
          ...previous,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: friendlyApiError(error),
            error: true,
          },
        ]);
      } finally {
        setAsking(false);
      }
    },
    [docInfo, asking, messages],
  );

  const goToPage = useCallback(
    (page: number) => {
      setCurrentPage(Math.min(Math.max(1, page), Math.max(1, pageCount)));
    },
    [pageCount],
  );

  const changeZoom = useCallback((nextZoom: number) => {
    setFitWidth(false);
    setZoom(Math.min(2, Math.max(0.5, nextZoom)));
  }, []);

  // Left/right arrow page navigation. Ignore events coming from inputs, textareas,
  // selects, contenteditable elements, or the settings/export dialogs so typing and
  // text editing are never hijacked.
  useEffect(() => {
    if (!pdfDoc) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (settingsOpen || exportOpen) return;

      const target = event.target;
      if (target instanceof Element) {
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      }

      event.preventDefault();
      setCurrentPage((page) => {
        const next = page + (event.key === 'ArrowRight' ? 1 : -1);
        return Math.min(Math.max(1, next), Math.max(1, pageCountRef.current));
      });
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pdfDoc, settingsOpen, exportOpen]);

  const onOcrTextChange = useCallback(
    (text: string) => {
      const page = currentPage;
      setPageTextContent(page, text);
      if (editTimerRef.current) window.clearTimeout(editTimerRef.current);
      editTimerRef.current = window.setTimeout(() => {
        void persistPageTexts(pageTextsRef.current, [{ page, text }]);
      }, 700);
    },
    [currentPage, persistPageTexts, setPageTextContent],
  );

  const editedTextMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const [page, result] of ocrResults) {
      const text = pageTexts[page - 1]?.text;
      if (text !== undefined && text.trim() !== result.ocrText.trim()) map.set(page, text);
    }
    return map;
  }, [ocrResults, pageTexts]);

  const modelReady = Boolean(
    settings && (settings.hasApiKey || canUseModelWithoutKey(settings.baseUrl)),
  );

  const disabledReason = !docInfo
    ? ocrBusy
      ? `正在 OCR 第 ${ocrBusy.page} 页…`
      : needsOcr
        ? '扫描件：识别出至少一页文字后即可提问'
        : indexing
          ? '正在提取并索引文档，请稍候…'
          : '请先打开并索引 PDF'
    : !modelReady
      ? '请先在设置中配置 API Key（本机服务可留空）'
      : savingIndex
        ? '正在同步 OCR 文本索引…'
        : null;

  const currentText = pageTexts[currentPage - 1]?.text ?? '';
  const currentIsOcr = ocrResults.has(currentPage);

  const clearChat = useCallback(() => {
    const docId = docInfo?.docId;
    const chatId = conversationId;
    setMessages([]);
    setChatArchived(false);
    setViewingHistory(null);
    setConversationId(crypto.randomUUID());
    if (docId) {
      void deleteChat(docId, chatId)
        .then(() => refreshChatHistory(docId))
        .catch(() => {
          // The UI is already cleared; a failed delete leaves an orphan archive file.
        });
    }
    setNotice('当前对话已清空并删除存档；下一条提问将开始新对话。');
  }, [conversationId, docInfo, refreshChatHistory]);

  const openChatHistory = useCallback(
    async (chatId: string): Promise<void> => {
      if (!docInfo) return;
      if (chatId === conversationId) {
        setViewingHistory(null);
        setHistoryOpen(false);
        return;
      }
      try {
        const archive = await getChat(docInfo.docId, chatId);
        setViewingHistory(archive);
        setHistoryOpen(false);
      } catch (error) {
        setNotice(`打开历史对话失败：${friendlyApiError(error)}`);
        void refreshChatHistory(docInfo.docId);
      }
    },
    [conversationId, docInfo, refreshChatHistory],
  );

  const exitHistory = useCallback(() => setViewingHistory(null), []);

  const deleteChatArchive = useCallback(
    async (chatId: string): Promise<void> => {
      if (!docInfo) return;
      try {
        await deleteChat(docInfo.docId, chatId);
        if (viewingHistory?.id === chatId) setViewingHistory(null);
        if (chatId === conversationId) {
          setMessages([]);
          setChatArchived(false);
          setConversationId(crypto.randomUUID());
        }
        await refreshChatHistory(docInfo.docId);
        setNotice('历史对话已删除，本地存档同步清除。');
      } catch (error) {
        setNotice(`删除历史对话失败：${friendlyApiError(error)}`);
      }
    },
    [conversationId, docInfo, refreshChatHistory, viewingHistory],
  );

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeRef.current;
    if (!drag) return;
    setSidebarWidth(clampSidebarWidth(drag.startWidth + drag.startX - event.clientX));
  };

  const onResizePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // pointer capture may already be released
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100 text-slate-900">
      <Toolbar
        fileName={fileName}
        pageCount={pageCount}
        currentPage={currentPage}
        zoom={zoom}
        fitWidth={fitWidth}
        hasApiKey={modelReady}
        indexingLabel={indexingLabel(indexing)}
        ocrPanelOpen={ocrPanelOpen}
        ocrBusyPage={ocrBusy?.page ?? null}
        sidebarOpen={sidebarOpen}
        onOpenFile={openFilePicker}
        onPageChange={goToPage}
        onZoomChange={changeZoom}
        onToggleFitWidth={() => setFitWidth((value) => !value)}
        onToggleOcrPanel={() => setOcrPanelOpen((value) => !value)}
        onToggleSidebar={() => setSidebarOpen((value) => !value)}
        onOpenExport={() => setExportOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {(indexing || indexError) && (
        <div
          className={`flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs ${
            indexError
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-indigo-200 bg-indigo-50 text-indigo-700'
          }`}
        >
          {indexError ? (
            <>
              <AlertTriangle size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={indexError}>
                {indexError}
              </span>
              <button
                type="button"
                onClick={() => setIndexError(null)}
                className="shrink-0 rounded p-0.5 hover:bg-rose-100"
                aria-label="关闭错误提示"
              >
                <X size={14} />
              </button>
            </>
          ) : (
            <>
              <Loader2 size={14} className="shrink-0 animate-spin" />
              <span>{indexingLabel(indexing)}</span>
              <span className="text-indigo-400">· 大文件可能需要十几秒</span>
            </>
          )}
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
        >
          {pdfDoc ? (
            <>
              <PdfViewer
                pdfDoc={pdfDoc}
                pageNumber={currentPage}
                zoom={zoom}
                fitWidth={fitWidth}
                onZoomChange={changeZoom}
              />
              {ocrPanelOpen && (
                <OcrPanel
                  page={currentPage}
                  text={currentText}
                  isOcrPage={currentIsOcr}
                  hasNativeText={
                    !currentIsOcr && !restoredSession && currentText.trim().length > 0
                  }
                  running={ocrBusy?.page === currentPage}
                  stage={ocrBusy?.page === currentPage ? ocrBusy.stage : null}
                  progress={ocrBusy?.page === currentPage ? ocrBusy.progress : 0}
                  error={ocrError}
                  language={ocrLanguage}
                  autoOcr={autoOcr}
                  indexState={savingIndex ? 'saving' : docInfo ? 'indexed' : 'unindexed'}
                  onLanguageChange={(language) => {
                    setOcrLanguage(language);
                    autoAttemptedRef.current.clear();
                  }}
                  onToggleAuto={setAutoOcr}
                  onRun={() => {
                    autoAttemptedRef.current.delete(currentPage);
                    void runOcrPage(currentPage);
                  }}
                  onChangeText={onOcrTextChange}
                  onClose={() => setOcrPanelOpen(false)}
                />
              )}
            </>
          ) : (
            <EmptyState onOpenFile={openFilePicker} />
          )}
        </section>

        {sidebarOpen && (
          <div data-testid="chat-sidebar-shell" className="flex shrink-0">
            <div
              data-testid="sidebar-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整问答侧边栏宽度"
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={onResizePointerEnd}
              onPointerCancel={onResizePointerEnd}
              style={{ touchAction: 'none' }}
              className="w-1.5 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-indigo-300 active:bg-indigo-400"
            />
            <div
              data-testid="chat-sidebar"
              style={{ width: sidebarWidth }}
              className="shrink-0 border-l border-slate-200 bg-white"
            >
              <ChatPanel
                messages={
                  viewingHistory ? (viewingHistory.messages as ChatMessage[]) : messages
                }
                asking={asking}
                hasApiKey={modelReady}
                documentReady={Boolean(docInfo)}
                disabledReason={
                  viewingHistory
                    ? '正在回看历史对话，返回当前对话后可继续提问。'
                    : disabledReason
                }
                archived={viewingHistory ? true : chatArchived}
                history={chatHistory}
                historyOpen={historyOpen}
                historyLoading={historyLoading}
                viewingHistory={Boolean(viewingHistory)}
                historyTitle={viewingHistory?.title}
                onToggleHistory={() => setHistoryOpen((open) => !open)}
                onOpenHistory={openChatHistory}
                onExitHistory={exitHistory}
                onDeleteHistory={deleteChatArchive}
                onAsk={ask}
                onCitationClick={goToPage}
                onOpenSettings={() => setSettingsOpen(true)}
                onClear={clearChat}
                onClose={() => setSidebarOpen(false)}
                documentName={docInfo?.name}
                currentPage={currentPage}
              />
            </div>
          </div>
        )}
      </main>

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(next) => {
            setSettings(next);
            setSettingsOpen(false);
            setNotice('设置已保存，刷新页面后依然生效。');
          }}
        />
      )}

      <ExportDialog
        open={exportOpen}
        pdfBytes={pdfBytes}
        pdfDoc={pdfDoc}
        pageCount={pageCount}
        fileName={fileName}
        language={ocrLanguage}
        editedText={editedTextMap}
        getPageResult={(page) => ocrResultsRef.current.get(page)}
        onPageResult={(result) => {
          ocrResultsRef.current.set(result.page, result);
          setOcrResults(new Map(ocrResultsRef.current));
          setPageTextContent(result.page, result.ocrText);
        }}
        onIndexPages={async (updates) => {
          const next = pageTextsRef.current.slice();
          for (const update of updates) {
            while (next.length < pageCountRef.current) next.push({ page: next.length + 1, text: '' });
            next[update.page - 1] = { page: update.page, text: update.text };
          }
          pageTextsRef.current = next;
          setPageTexts(next);
          const existing = docInfoRef.current;
          if (existing) {
            const info = await updateDocumentPages(existing.docId, updates);
            applyDocInfo(info);
          } else {
            const info = await uploadDocument(fileName ?? 'document.pdf', next);
            applyDocInfo(info);
          }
        }}
        onClose={() => setExportOpen(false)}
        onFinished={(summary) => setNotice(`${summary} 问答索引已同步。`)}
      />

      <input
        ref={fileInputRef}
        data-testid="pdf-file-input"
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handleFile(file);
        }}
      />

      {notice && (
        <div
          data-testid="notice"
          className="fixed bottom-4 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-slate-900/95 px-4 py-2 text-xs text-white shadow-lg"
        >
          {notice}
        </div>
      )}
    </div>
  );
}
