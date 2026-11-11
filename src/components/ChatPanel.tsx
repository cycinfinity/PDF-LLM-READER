import {
  AlertTriangle,
  ArrowLeft,
  BookOpenCheck,
  History,
  Loader2,
  Send,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { enhancePrompt, friendlyApiError } from '../lib/api';
import type { AskContextInfo, ChatMessage, ChatSummary, Citation } from '../lib/types';

export interface ChatPanelProps {
  messages: ChatMessage[];
  asking: boolean;
  hasApiKey: boolean;
  documentReady: boolean;
  disabledReason: string | null;
  archived: boolean;
  history: ChatSummary[];
  historyOpen: boolean;
  historyLoading: boolean;
  viewingHistory: boolean;
  historyTitle?: string;
  onToggleHistory: () => void;
  onOpenHistory: (chatId: string) => void;
  onExitHistory: () => void;
  onDeleteHistory: (chatId: string) => void;
  onAsk: (question: string) => void;
  onCitationClick: (page: number) => void;
  onOpenSettings: () => void;
  onClear: () => void;
  onClose: () => void;
  /** Used to give the enhancement prompt a little context. */
  documentName?: string;
  /** Current PDF page, used as context for the enhancement prompt. */
  currentPage?: number;
}

interface EnhanceFeedback {
  kind: 'info' | 'success' | 'error';
  text: string;
}

const EXAMPLE_QUESTIONS = [
  '这份文档主要讲了什么？',
  '总结第 1 页的内容',
  '文档中定义了哪些核心概念？',
];

function formatPages(pages: number[]): string {
  if (pages.length === 0) return '—';
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const shown = sorted.slice(0, 8).join(', ');
  return sorted.length > 8 ? `${shown} 等 ${sorted.length} 页` : shown;
}

function CitationChips({
  citations,
  onCitationClick,
}: {
  citations: Citation[];
  onCitationClick: (page: number) => void;
}) {
  if (citations.length === 0) return null;
  const seen = new Set<number>();
  const unique = citations.filter((citation) => {
    if (seen.has(citation.page)) return false;
    seen.add(citation.page);
    return true;
  });

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-slate-500">来源</span>
      {unique.map((citation) => (
        <button
          key={`${citation.chunkId}-${citation.page}`}
          type="button"
          data-testid={`citation-p${citation.page}`}
          title={citation.snippet}
          onClick={() => onCitationClick(citation.page)}
          className="rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100"
        >
          [p.{citation.page}
          {citation.pageEnd > citation.page ? `–${citation.pageEnd}` : ''}]
        </button>
      ))}
    </div>
  );
}

function formatArchiveDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ContextFooter({ info }: { info: AskContextInfo }) {
  const modeLabel =
    info.mode === 'full'
      ? '全文上下文'
      : info.mode === 'summary'
        ? '分层抽样'
        : info.mode === 'pages'
          ? '指定页'
          : info.mode === 'chapter'
            ? '指定章节'
            : '相关片段';
  const targetLabel =
    info.mode === 'pages' && info.requestedPages && info.requestedPages.length > 0
      ? ` · 目标页 ${formatPages(info.requestedPages)}`
      : '';
  const chapterLabel =
    info.mode === 'chapter' && info.requestedChapter ? ` · ${info.requestedChapter}` : '';
  return (
    <div className="mt-2 text-[10px] text-slate-400" data-testid="context-footer">
      <div>
        {modeLabel}
        {targetLabel}
        {chapterLabel} · {info.chunksUsed} 段 · {info.contextChars.toLocaleString()} 字符 · 页码{' '}
        {formatPages(info.pages)}
      </div>
      {info.note ? (
        <div className="mt-0.5 text-[10px] text-amber-600/80" data-testid="context-note">
          {info.note}
        </div>
      ) : null}
    </div>
  );
}

export function ChatPanel({
  messages,
  asking,
  hasApiKey,
  documentReady,
  disabledReason,
  archived,
  history,
  historyOpen,
  historyLoading,
  viewingHistory,
  historyTitle,
  onToggleHistory,
  onOpenHistory,
  onExitHistory,
  onDeleteHistory,
  onAsk,
  onCitationClick,
  onOpenSettings,
  onClear,
  onClose,
  documentName,
  currentPage,
}: ChatPanelProps) {
  const [question, setQuestion] = useState('');
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceFeedback, setEnhanceFeedback] = useState<EnhanceFeedback | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, asking]);

  const submit = () => {
    const trimmed = question.trim();
    if (!trimmed || asking || disabledReason) return;
    setQuestion('');
    setEnhanceFeedback(null);
    onAsk(trimmed);
  };

  const handleEnhance = async () => {
    if (enhancing) return;
    const trimmed = question.trim();
    if (!trimmed) {
      setEnhanceFeedback({ kind: 'error', text: '请先在输入框写下问题，再点击 💪 增强。' });
      textareaRef.current?.focus();
      return;
    }
    if (!hasApiKey) {
      setEnhanceFeedback({
        kind: 'error',
        text: '当前没有可用的模型服务，请先在设置中配置 API Key 或本机服务。',
      });
      return;
    }

    setEnhancing(true);
    setEnhanceFeedback({ kind: 'info', text: '正在用当前模型增强提示词…' });
    try {
      const result = await enhancePrompt(trimmed, { documentName, page: currentPage });
      setQuestion(result.enhanced);
      setEnhanceFeedback({ kind: 'success', text: '已增强并回填，请确认或编辑后再发送。' });
      textareaRef.current?.focus();
    } catch (error) {
      setEnhanceFeedback({
        kind: 'error',
        text: `增强失败：${friendlyApiError(error)}。原输入已保留，可修改后重试。`,
      });
    } finally {
      setEnhancing(false);
    }
  };

  const inputDisabled = Boolean(disabledReason) || asking || enhancing;

  return (
    <aside data-testid="chat-panel" className="flex h-full min-h-0 flex-col bg-white">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
            <Sparkles size={15} />
          </div>
          <div>
            <div className="text-sm font-semibold">文档问答</div>
            <div className="text-[11px] text-slate-500">仅依据当前 PDF 内容回答</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <span
            data-testid="chat-archive-status"
            title={viewingHistory ? '正在回看一条历史存档' : archived ? '对话已自动存档到本地服务' : '对话尚未存档'}
            className={`mr-1 text-[10px] ${viewingHistory || archived ? 'text-emerald-600' : 'text-slate-400'}`}
          >
            {viewingHistory ? '历史存档' : archived ? '已存档' : '未存档'}
          </span>
          <button
            type="button"
            data-testid="chat-history-toggle"
            onClick={onToggleHistory}
            className={`relative rounded-md p-1.5 text-slate-500 hover:bg-slate-100 ${historyOpen ? 'bg-slate-100 text-indigo-600' : ''}`}
            title="展开/收起历史对话"
          >
            <History size={16} />
            {history.length > 0 && (
              <span className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-indigo-600 px-1 text-[9px] font-semibold leading-[14px] text-white">
                {history.length > 99 ? '99+' : history.length}
              </span>
            )}
          </button>
          <button
            type="button"
            data-testid="chat-clear"
            disabled={messages.length === 0 || viewingHistory}
            onClick={onClear}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
            title="清空对话（同时清除本地存档）"
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
            title="打开设置"
          >
            <Settings size={16} />
          </button>
          <button
            type="button"
            data-testid="sidebar-close"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
            title="关闭侧边栏（可从顶部按钮重新打开）"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {historyOpen && (
        <div
          data-testid="chat-history-panel"
          className="max-h-64 shrink-0 overflow-y-auto border-b border-slate-200 bg-slate-50/80"
        >
          <div className="flex items-center justify-between px-4 pb-1 pt-2 text-[11px] font-medium text-slate-600">
            <span>历史对话</span>
            <span className="font-normal text-slate-400">{history.length} 条</span>
          </div>
          {historyLoading ? (
            <div className="px-4 pb-3 text-[11px] text-slate-400">读取历史存档…</div>
          ) : history.length === 0 ? (
            <div className="px-4 pb-3 text-[11px] text-slate-400">
              还没有历史对话。刷新页面会开启新对话，旧对话会出现在这里。
            </div>
          ) : (
            <ul className="px-2 pb-2">
              {history.map((item) => (
                <li
                  key={item.id}
                  data-testid={`chat-history-item-${item.id}`}
                  className="group flex items-center gap-1 rounded-md hover:bg-white"
                >
                  <button
                    type="button"
                    onClick={() => onOpenHistory(item.id)}
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                    title={item.preview || item.title}
                  >
                    <div className="truncate text-xs font-medium text-slate-700">{item.title}</div>
                    <div className="text-[10px] text-slate-400">
                      {formatArchiveDate(item.updatedAt)} · {item.messageCount} 条消息
                    </div>
                  </button>
                  <button
                    type="button"
                    data-testid={`chat-history-delete-${item.id}`}
                    onClick={() => onDeleteHistory(item.id)}
                    className="mr-1 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                    title="删除这条历史对话（同时删除本地存档）"
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {viewingHistory && (
        <div
          data-testid="chat-history-banner"
          className="shrink-0 border-b border-indigo-100 bg-indigo-50 px-4 py-2 text-[11px] text-indigo-800"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">正在回看历史对话{historyTitle ? `：${historyTitle}` : ''}</span>
            <button
              type="button"
              data-testid="chat-history-exit"
              onClick={onExitHistory}
              className="inline-flex shrink-0 items-center gap-1 rounded border border-indigo-200 bg-white px-2 py-0.5 font-medium hover:bg-indigo-100"
            >
              <ArrowLeft size={12} /> 返回当前对话
            </button>
          </div>
        </div>
      )}

      <div ref={listRef} data-testid="chat-messages" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/60 p-4 text-xs text-slate-500">
            {documentReady ? (
              <>
                <div className="mb-2 flex items-center gap-1.5 font-medium text-slate-700">
                  <BookOpenCheck size={14} />
                  文档已就绪，可以开始提问
                </div>
                <div className="space-y-1.5">
                  {EXAMPLE_QUESTIONS.map((example) => (
                    <button
                      key={example}
                      type="button"
                      disabled={Boolean(disabledReason)}
                      onClick={() => onAsk(example)}
                      className="block w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-left text-xs text-slate-600 hover:border-indigo-200 hover:text-indigo-700 disabled:opacity-50"
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="leading-relaxed">
                打开一份带文字层的 PDF 后，这里会显示对话。
                <br />
                答案只基于文档内容，并给出可点击的页码。
              </div>
            )}
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            data-testid={`chat-message-${message.role}`}
            className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
          >
            <div
              className={`max-w-[92%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                message.role === 'user'
                  ? 'bg-indigo-600 text-white'
                  : message.error
                    ? 'border border-rose-200 bg-rose-50 text-rose-700'
                    : message.notFound
                      ? 'border border-amber-200 bg-amber-50 text-amber-900'
                      : 'border border-slate-200 bg-slate-50 text-slate-800'
              }`}
            >
              {message.error && (
                <div className="mb-1 flex items-center gap-1 text-[11px] font-medium">
                  <AlertTriangle size={12} /> 请求失败
                </div>
              )}
              {message.notFound && (
                <div className="mb-1 flex items-center gap-1 text-[11px] font-medium">
                  <AlertTriangle size={12} /> 未找到依据
                </div>
              )}
              <div className="message-content">{message.content}</div>
              {message.role === 'assistant' && !message.error && (
                <>
                  <CitationChips citations={message.citations ?? []} onCitationClick={onCitationClick} />
                  {message.contextInfo && <ContextFooter info={message.contextInfo} />}
                </>
              )}
            </div>
          </div>
        ))}

        {asking && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              <Loader2 size={14} className="animate-spin" />
              正在检索文档并生成回答…
            </div>
          </div>
        )}
      </div>

      {!hasApiKey && (
        <div className="shrink-0 border-t border-amber-200 bg-amber-50 px-4 py-2 text-[11px] text-amber-800">
          <div className="flex items-center justify-between gap-2">
            <span>尚未配置 API Key，问答暂不可用。</span>
            <button
              type="button"
              onClick={onOpenSettings}
              className="shrink-0 rounded border border-amber-300 bg-white px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
            >
              去配置
            </button>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t border-slate-200 p-3">
        <div className="rounded-lg border border-slate-300 bg-white focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
          <textarea
            ref={textareaRef}
            data-testid="chat-input"
            value={question}
            disabled={inputDisabled}
            rows={2}
            onChange={(event) => {
              setQuestion(event.target.value);
              if (enhanceFeedback) setEnhanceFeedback(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={
              disabledReason
                ? disabledReason
                : '针对文档提问，例如：第 3 页的结论是什么？（Enter 发送，Shift+Enter 换行）'
            }
            className="max-h-40 min-h-[52px] w-full resize-none rounded-lg bg-transparent px-3 pt-2 text-sm outline-none placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
          />
          {enhanceFeedback && (
            <div
              data-testid="enhance-status"
              role="status"
              aria-live="polite"
              className={`px-3 pb-1 text-[11px] ${
                enhanceFeedback.kind === 'error'
                  ? 'text-rose-600'
                  : enhanceFeedback.kind === 'success'
                    ? 'text-emerald-600'
                    : 'text-slate-500'
              }`}
            >
              {enhanceFeedback.text}
            </div>
          )}
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-[10px] text-slate-400">
              {asking ? '生成中…' : '回答仅供参考，请核对页码原文'}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="enhance-prompt"
                onClick={handleEnhance}
                disabled={Boolean(disabledReason) || asking || enhancing}
                title="增强提示词：用当前模型重写输入，不会自动发送"
                aria-label="增强提示词"
                className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {enhancing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <span aria-hidden="true" className="text-sm leading-none">
                    💪
                  </span>
                )}
                增强
              </button>
              <button
                type="button"
                data-testid="chat-send"
                onClick={submit}
                disabled={inputDisabled || question.trim().length === 0}
                className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {asking ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                发送
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
