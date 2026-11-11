import { Check, Copy, Loader2, ScanText, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OCR_LANGUAGES, type OcrLanguage, type OcrStage } from '../lib/ocr';

export interface OcrPanelProps {
  page: number;
  text: string;
  /** True when the page came from OCR rather than the PDF's own text layer. */
  isOcrPage: boolean;
  hasNativeText: boolean;
  running: boolean;
  stage: OcrStage | null;
  progress: number;
  error: string | null;
  language: OcrLanguage;
  autoOcr: boolean;
  indexState: 'unindexed' | 'indexed' | 'saving';
  onLanguageChange: (language: OcrLanguage) => void;
  onToggleAuto: (enabled: boolean) => void;
  onRun: () => void;
  onChangeText: (text: string) => void;
  onClose: () => void;
}

export function OcrPanel({
  page,
  text,
  isOcrPage,
  hasNativeText,
  running,
  stage,
  progress,
  error,
  language,
  autoOcr,
  indexState,
  onLanguageChange,
  onToggleAuto,
  onRun,
  onChangeText,
  onClose,
}: OcrPanelProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const statusLabel = running
    ? stage === 'rendering'
      ? '渲染页面…'
      : `识别中 ${Math.round(progress * 100)}%`
    : error
      ? '识别失败'
      : isOcrPage
        ? hasNativeText
          ? 'OCR 结果（可编辑）'
          : 'OCR 完成 · 可编辑校正'
        : hasNativeText
          ? 'PDF 原生文字层 · 可直接编辑校正'
          : text.trim().length > 0
            ? '已保存的页文本 · 可直接编辑校正'
            : '该页尚未识别';

  const copyText = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section
      data-testid="ocr-panel"
      className="flex h-[240px] shrink-0 flex-col border-t border-slate-200 bg-white"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-100 px-3 py-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
          <ScanText size={14} className="text-indigo-600" />
          OCR 文本
          <span className="font-normal text-slate-400">第 {page} 页</span>
        </div>
        <span
          data-testid="ocr-status"
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            error
              ? 'bg-rose-50 text-rose-700'
              : running
                ? 'bg-amber-50 text-amber-700'
                : isOcrPage
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-slate-100 text-slate-500'
          }`}
        >
          {running && <Loader2 size={10} className="mr-0.5 inline animate-spin" />}
          {statusLabel}
        </span>
        <span className="text-[10px] text-slate-400">
          {indexState === 'saving' ? '索引更新中…' : indexState === 'indexed' ? '已同步本地索引' : '尚未进入索引'}
        </span>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-testid="ocr-run"
            onClick={onRun}
            disabled={running}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            {running ? <Loader2 size={12} className="animate-spin" /> : <ScanText size={12} />}
            {isOcrPage ? '重新识别' : '识别此页'}
          </button>
          <button
            type="button"
            data-testid="ocr-copy"
            onClick={copyText}
            disabled={!text}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
            {copied ? '已复制' : '复制'}
          </button>
          <button
            type="button"
            data-testid="ocr-close"
            onClick={onClose}
            title="收起 OCR 面板"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {running && (
        <div data-testid="ocr-progress" className="h-1 w-full shrink-0 bg-slate-100">
          <div
            className="h-1 bg-indigo-500 transition-all"
            style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }}
          />
        </div>
      )}

      <textarea
        data-testid="ocr-textarea"
        value={text}
        onChange={(event) => onChangeText(event.target.value)}
        placeholder={
          hasNativeText
            ? '该页已有 PDF 原生文字层；可直接修改并同步索引。'
            : text.trim().length > 0
              ? '该页文字已保存在本地服务；可直接修改并同步索引。'
              : '该页尚未识别。点击「识别此页」，或开启自动识别后翻到这一页。'
        }
        spellCheck={false}
        className="min-h-0 flex-1 resize-none bg-slate-50/40 px-3 py-2 font-sans text-xs leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
      />

      {error && (
        <div className="shrink-0 border-t border-rose-100 bg-rose-50 px-3 py-1 text-[11px] text-rose-700">
          {error}
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-slate-100 px-3 py-1.5 text-[11px] text-slate-500">
        <label className="flex items-center gap-1">
          识别语言
          <select
            data-testid="ocr-language"
            value={language}
            onChange={(event) => onLanguageChange(event.target.value as OcrLanguage)}
            disabled={running}
            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] outline-none"
          >
            {OCR_LANGUAGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            data-testid="ocr-auto"
            type="checkbox"
            checked={autoOcr}
            onChange={(event) => onToggleAuto(event.target.checked)}
            className="h-3 w-3 accent-indigo-600"
          />
          翻页自动识别
        </label>
        <span className="ml-auto">
          {text.length.toLocaleString()} 字符 · 编辑内容仅保留在当前会话（刷新丢失），导出文本 PDF 可持久化
        </span>
      </div>
    </section>
  );
}
