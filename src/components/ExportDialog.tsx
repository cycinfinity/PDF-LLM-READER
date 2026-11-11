import { Download, FileDown, Loader2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from '../lib/pdf';
import {
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
  disposeOcrWorker,
  evaluatePageAccuracy,
  ocrPdfPage,
  type OcrLanguage,
  type OcrPageResult,
} from '../lib/ocr';
import {
  buildTextPdf,
  downloadPdf,
  type BuildTextPdfResult,
  type ConversionMode,
} from '../lib/textPdf';

export interface ExportDialogProps {
  open: boolean;
  pdfBytes: ArrayBuffer | null;
  pdfDoc: PDFDocumentProxy | null;
  pageCount: number;
  fileName: string | null;
  language: OcrLanguage;
  editedText: Map<number, string>;
  getPageResult: (page: number) => OcrPageResult | undefined;
  onPageResult: (result: OcrPageResult) => void;
  onIndexPages: (pageTexts: Array<{ page: number; text: string }>) => Promise<void>;
  onClose: () => void;
  onFinished: (summary: string) => void;
}

type Phase = 'idle' | 'running' | 'building' | 'indexing' | 'done' | 'error';

export function ExportDialog({
  open,
  pdfBytes,
  pdfDoc,
  pageCount,
  fileName,
  language,
  editedText,
  getPageResult,
  onPageResult,
  onIndexPages,
  onClose,
  onFinished,
}: ExportDialogProps) {
  const [mode, setMode] = useState<ConversionMode>('high');
  const [threshold, setThreshold] = useState(DEFAULT_HIGH_CONFIDENCE_THRESHOLD);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(1);
  const [phase, setPhase] = useState<Phase>('idle');
  const [doneCount, setDoneCount] = useState(0);
  const [stageLabel, setStageLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildTextPdfResult | null>(null);
  const [highAccuracyCount, setHighAccuracyCount] = useState(0);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPhase('idle');
    setDoneCount(0);
    setStageLabel('');
    setError(null);
    setResult(null);
    setHighAccuracyCount(0);
    setRangeStart(1);
    setRangeEnd(Math.max(1, pageCount));
    cancelRef.current = false;
  }, [open, pageCount]);

  const from = Math.min(Math.max(1, rangeStart), Math.max(1, pageCount));
  const to = Math.min(Math.max(from, rangeEnd), Math.max(1, pageCount));
  const rangeCount = Math.max(0, to - from + 1);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cached = Array.from({ length: rangeCount }, (_, index) =>
      getPageResult(from + index),
    ).filter(Boolean) as OcrPageResult[];
    if (cached.length === 0) return;
    Promise.resolve().then(() => {
      if (cancelled) return;
      const count = cached.filter((item) => evaluatePageAccuracy(item, threshold).highAccuracy).length;
      setHighAccuracyCount(count);
    });
    return () => {
      cancelled = true;
    };
  }, [open, from, rangeCount, threshold, getPageResult]);

  if (!open) return null;

  const running = phase === 'running' || phase === 'building' || phase === 'indexing';
  const percent = rangeCount > 0 ? Math.round((doneCount / rangeCount) * 100) : 0;

  const start = async () => {
    if (!pdfBytes || !pdfDoc || pageCount === 0) return;
    setError(null);
    setResult(null);
    setDoneCount(0);
    cancelRef.current = false;
    setPhase('running');

    try {
      const results: OcrPageResult[] = [];
      for (let page = from; page <= to; page += 1) {
        if (cancelRef.current) {
          setPhase('idle');
          return;
        }
        setStageLabel(`OCR 第 ${page} / ${pageCount} 页（范围 ${from}–${to}）…`);
        let item = getPageResult(page);
        if (!item) {
          item = await ocrPdfPage(pdfDoc, page, language);
          onPageResult(item);
        }
        results.push(item);
        setDoneCount(results.length);
        // Recycle the tesseract worker periodically; long OCR batches can
        // exhaust the worker's WASM heap and make recognize() hang.
        if ((page - from + 1) % 8 === 0 && page < to) {
          setStageLabel('正在重置 OCR 进程并继续…');
          await disposeOcrWorker();
        }
      }

      if (cancelRef.current) {
        setPhase('idle');
        return;
      }

      setPhase('building');
      setStageLabel('正在写入不可见文字层…');
      const built = await buildTextPdf({
        originalBytes: pdfBytes,
        results,
        mode,
        threshold,
        editedText,
        onProgress: (done, total) => {
          setStageLabel(`正在写入不可见文字层 ${done} / ${total} 页…`);
        },
      });

      setPhase('indexing');
      setStageLabel('正在更新问答索引…');
      const indexedPages = results
        .filter((item) => mode === 'all' || evaluatePageAccuracy(item, threshold).highAccuracy)
        .map((item) => ({
          page: item.page,
          text: editedText.get(item.page) ?? item.ocrText,
        }));
      if (indexedPages.length > 0) {
        await onIndexPages(indexedPages);
      }

      setResult(built);
      setPhase('done');
      setStageLabel('');
      onFinished(
        `文本 PDF 已生成：${built.textPages} 页写入文字层（本次范围 ${from}–${to} / 共 ${pageCount} 页）` +
          (built.skippedPages.length > 0 ? `，${built.skippedPages.length} 页因准确度不足跳过。` : '。'),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPhase('error');
    }
  };

  const download = () => {
    if (!result) return;
    const baseName = (fileName ?? 'document').replace(/\.pdf$/i, '');
    downloadPdf(result.bytes, `${baseName}-text.pdf`);
  };

  const close = () => {
    if (running) {
      cancelRef.current = true;
      return;
    }
    onClose();
  };

  const cachedCount = Array.from({ length: rangeCount }, (_, index) =>
    Boolean(getPageResult(from + index)),
  ).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        data-testid="export-dialog"
        className="flex w-full max-w-2xl flex-col rounded-xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
              <FileDown size={17} />
            </div>
            <div>
              <div className="text-sm font-semibold">转换为文本 PDF</div>
              <div className="text-[11px] text-slate-500">
                保留原始页面图像，叠加不可见文字层；导出后可被搜索与复制
              </div>
            </div>
          </div>
          <button
            type="button"
            data-testid="export-close"
            onClick={close}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label
              className={`cursor-pointer rounded-lg border p-3 text-xs ${
                mode === 'high'
                  ? 'border-indigo-300 bg-indigo-50/60'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                data-testid="export-mode-high"
                type="radio"
                name="export-mode"
                value="high"
                checked={mode === 'high'}
                onChange={() => setMode('high')}
                disabled={running}
                className="mr-1.5 accent-indigo-600"
              />
              <span className="font-medium text-slate-800">只转换准确度高的页面</span>
              <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
                跳过识别质量不足的页面，避免把错字写入文字层；较稳妥。
              </div>
            </label>
            <label
              className={`cursor-pointer rounded-lg border p-3 text-xs ${
                mode === 'all'
                  ? 'border-indigo-300 bg-indigo-50/60'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                data-testid="export-mode-all"
                type="radio"
                name="export-mode"
                value="all"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
                disabled={running}
                className="mr-1.5 accent-indigo-600"
              />
              <span className="font-medium text-slate-800">全部强制转换</span>
              <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
                所有识别出文字的页面都写入文字层；适合影印质量较好、需要完整检索的文档。
              </div>
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-700">高准确度阈值（平均行置信度）</span>
              <input
                data-testid="export-threshold"
                type="range"
                min={50}
                max={99}
                step={1}
                value={threshold}
                disabled={running || mode === 'all'}
                onChange={(event) => setThreshold(Number(event.target.value))}
                className="w-40 accent-indigo-600"
              />
              <span className="rounded bg-white px-1.5 py-0.5 font-mono text-slate-800">
                {threshold}
              </span>
            </div>
            <p className="mt-1 leading-relaxed">
              判定：该页所有行的平均置信度 ≥ {threshold}，有效字符 ≥ 20，且低置信行（&lt; 60）占比 ≤
              30%，三个条件同时满足才视为「高准确度」。默认 {DEFAULT_HIGH_CONFIDENCE_THRESHOLD} 是经验阈值：V4 前 10 页平均 93.6、31–40 页
              82.5，能区分干净页与低质量页；可按扫描件调整。
            </p>
            <p className="mt-1 text-slate-500">
              已缓存 OCR 结果：{cachedCount} / {rangeCount} 页
              {highAccuracyCount > 0 && `，其中高准确度 ${highAccuracyCount} 页`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
            <span className="font-medium text-slate-700">转换页码范围</span>
            <input
              data-testid="export-page-from"
              type="number"
              min={1}
              max={pageCount}
              value={rangeStart}
              disabled={running}
              onChange={(event) => setRangeStart(Number(event.target.value))}
              className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-center text-slate-800"
            />
            <span>–</span>
            <input
              data-testid="export-page-to"
              type="number"
              min={1}
              max={pageCount}
              value={rangeEnd}
              disabled={running}
              onChange={(event) => setRangeEnd(Number(event.target.value))}
              className="w-16 rounded border border-slate-300 px-1.5 py-0.5 text-center text-slate-800"
            />
            <span>共 {pageCount} 页（默认全部；超长扫描书可分批转换，避免浏览器内存不足）</span>
          </div>

          {running && (
            <div data-testid="export-progress" className="space-y-1">
              <div className="flex items-center justify-between text-[11px] text-slate-600">
                <span className="inline-flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" /> {stageLabel}
                </span>
                <span>{percent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
                <div
                  className="h-1.5 bg-indigo-500 transition-all"
                  style={{ width: `${Math.max(2, percent)}%` }}
                />
              </div>
              <div className="text-[10px] text-slate-400">
                OCR 在浏览器本地运行，不会把页面图像上传到服务器；首次识别需要加载语言模型，请耐心等待。
              </div>
            </div>
          )}

          {phase === 'done' && result && (
            <div
              data-testid="export-result"
              className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] leading-relaxed text-emerald-800"
            >
              完成：{result.textPages} / {result.totalPages} 页写入文字层
              {result.skippedPages.length > 0 && `，跳过 ${result.skippedPages.length} 页`}；平均置信度{' '}
              {result.averageConfidence.toFixed(1)}；字体{' '}
              {result.usedCjkFont ? 'Noto Sans SC' : 'Helvetica（仅拉丁字符）'}。
              {result.warnings.map((warning) => (
                <div key={warning} className="mt-1 text-emerald-700">
                  {warning}
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-5 py-3">
          <span className="text-[10px] text-slate-400">
            识别语言：{language === 'eng' ? 'English' : language === 'chi_sim' ? '简体中文' : '中英混排'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50"
            >
              {running ? '取消' : '关闭'}
            </button>
            {phase === 'done' && result ? (
              <button
                type="button"
                data-testid="export-download"
                onClick={download}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
              >
                <Download size={14} />
                下载文本 PDF
              </button>
            ) : (
              <button
                type="button"
                data-testid="export-start"
                onClick={start}
                disabled={running || !pdfDoc || pageCount === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
                开始转换
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
