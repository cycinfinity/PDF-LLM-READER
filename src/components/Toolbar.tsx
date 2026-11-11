import {
  ChevronLeft,
  ChevronRight,
  FileDown,
  FileText,
  Loader2,
  Maximize2,
  PanelRight,
  Plus,
  ScanText,
  Settings,
  ZoomIn,
} from 'lucide-react';
import { useEffect, useState } from 'react';

const ZOOM_OPTIONS = [50, 75, 100, 125, 150, 200];

export interface ToolbarProps {
  fileName: string | null;
  pageCount: number;
  currentPage: number;
  zoom: number;
  fitWidth: boolean;
  hasApiKey: boolean;
  indexingLabel: string | null;
  ocrPanelOpen: boolean;
  ocrBusyPage: number | null;
  sidebarOpen: boolean;
  onOpenFile: () => void;
  onPageChange: (page: number) => void;
  onZoomChange: (zoom: number) => void;
  onToggleFitWidth: () => void;
  onToggleOcrPanel: () => void;
  onToggleSidebar: () => void;
  onOpenExport: () => void;
  onOpenSettings: () => void;
}

export function Toolbar({
  fileName,
  pageCount,
  currentPage,
  zoom,
  fitWidth,
  hasApiKey,
  indexingLabel,
  ocrPanelOpen,
  ocrBusyPage,
  sidebarOpen,
  onOpenFile,
  onPageChange,
  onZoomChange,
  onToggleFitWidth,
  onToggleOcrPanel,
  onToggleSidebar,
  onOpenExport,
  onOpenSettings,
}: ToolbarProps) {
  const [pageInput, setPageInput] = useState(String(currentPage));

  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const commitPage = () => {
    const parsed = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(currentPage));
      return;
    }
    const clamped = Math.min(Math.max(parsed, 1), Math.max(pageCount, 1));
    onPageChange(clamped);
    setPageInput(String(clamped));
  };

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-white px-4 py-2.5">
      <div className="flex items-center gap-2 pr-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
          <FileText size={17} />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">PDF + LLM 阅读器</div>
          <div className="text-[11px] text-slate-500">文档内问答 · 页码可追溯</div>
        </div>
      </div>

      <button
        type="button"
        data-testid="open-file"
        onClick={onOpenFile}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        <Plus size={14} />
        打开 PDF
      </button>

      <div className="min-w-0 max-w-[320px] flex-1 truncate text-xs text-slate-600">
        {fileName ? (
          <span title={fileName}>
            <span className="font-medium text-slate-800">{fileName}</span>
            <span className="ml-1.5 text-slate-500">
              {pageCount} 页{indexingLabel ? ` · ${indexingLabel}` : ''}
            </span>
          </span>
        ) : (
          <span className="text-slate-400">尚未打开文件</span>
        )}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <div className="flex items-center rounded-md border border-slate-300 bg-white">
          <button
            type="button"
            data-testid="page-prev"
            aria-label="上一页"
            disabled={!pageCount || currentPage <= 1}
            onClick={() => onPageChange(currentPage - 1)}
            className="px-1.5 py-1.5 text-slate-600 disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="flex items-center gap-1 border-x border-slate-200 px-1.5 py-1 text-xs text-slate-600">
            <input
              data-testid="page-input"
              aria-label="页码"
              value={pageInput}
              onChange={(event) => setPageInput(event.target.value.replace(/[^\d]/g, ''))}
              onBlur={commitPage}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitPage();
              }}
              className="w-10 rounded border border-transparent bg-transparent px-1 py-0.5 text-center font-medium text-slate-800 outline-none focus:border-indigo-400"
            />
            <span>/ {pageCount || 0}</span>
          </div>
          <button
            type="button"
            data-testid="page-next"
            aria-label="下一页"
            disabled={!pageCount || currentPage >= pageCount}
            onClick={() => onPageChange(currentPage + 1)}
            className="px-1.5 py-1.5 text-slate-600 disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <label className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-600">
          <ZoomIn size={14} />
          <select
            data-testid="zoom-select"
            aria-label="缩放比例"
            value={fitWidth ? 'fit' : String(Math.round(zoom * 100))}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'fit') {
                onToggleFitWidth();
              } else {
                onZoomChange(Number(value) / 100);
              }
            }}
            className="bg-transparent py-0.5 pr-1 text-xs outline-none"
            disabled={!pageCount}
          >
            {ZOOM_OPTIONS.map((percent) => (
              <option key={percent} value={percent}>
                {percent}%
              </option>
            ))}
            {!ZOOM_OPTIONS.includes(Math.round(zoom * 100)) && (
              <option value={Math.round(zoom * 100)}>{Math.round(zoom * 100)}%</option>
            )}
            <option value="fit">适应宽度</option>
          </select>
        </label>

        <button
          type="button"
          data-testid="fit-width"
          onClick={onToggleFitWidth}
          disabled={!pageCount}
          title="适应宽度"
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs font-medium disabled:opacity-30 ${
            fitWidth
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          <Maximize2 size={14} />
          适应宽度
        </button>

        <button
          type="button"
          data-testid="ocr-panel-toggle"
          onClick={onToggleOcrPanel}
          disabled={!pageCount}
          title="打开/收起 OCR 文本面板"
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium disabled:opacity-30 ${
            ocrPanelOpen
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
          }`}
        >
          {ocrBusyPage !== null ? <Loader2 size={14} className="animate-spin" /> : <ScanText size={14} />}
          OCR 文本
          {ocrBusyPage !== null && (
            <span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">
              p.{ocrBusyPage}
            </span>
          )}
        </button>

        <button
          type="button"
          data-testid="export-button"
          onClick={onOpenExport}
          disabled={!pageCount}
          title="将扫描页 OCR 后导出带文字层的文本 PDF"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-30"
        >
          <FileDown size={14} />
          文本 PDF
        </button>

        <button
          type="button"
          data-testid="sidebar-toggle"
          onClick={onToggleSidebar}
          title={sidebarOpen ? '关闭问答侧边栏' : '打开问答侧边栏'}
          className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium ${
            sidebarOpen
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
          }`}
        >
          <PanelRight size={14} />
          {sidebarOpen ? '收起问答栏' : '打开问答栏'}
        </button>

        <button
          type="button"
          data-testid="settings-button"
          onClick={onOpenSettings}
          className="relative inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          <Settings size={14} />
          设置
          {hasApiKey ? (
            <span
              title="模型服务已就绪"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500"
            />
          ) : (
            <span
              title="未配置模型服务（或 API Key）"
              className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-white bg-amber-500"
            />
          )}
        </button>
      </div>
    </header>
  );
}
