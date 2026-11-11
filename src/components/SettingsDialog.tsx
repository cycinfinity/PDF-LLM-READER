import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { friendlyApiError, saveSettings, testConnection } from '../lib/api';
import type { PublicSettings, SettingsDraft } from '../lib/types';

const PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地，无需 Key）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容服务',
    baseUrl: '',
    model: '',
  },
] as const;

type PresetId = (typeof PRESETS)[number]['id'];

function detectPreset(baseUrl: string): PresetId {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  const match = PRESETS.find(
    (preset) => preset.id !== 'custom' && preset.baseUrl.replace(/\/+$/, '') === normalized,
  );
  return match?.id ?? 'custom';
}

interface SettingsDialogProps {
  settings: PublicSettings;
  onClose: () => void;
  onSaved: (settings: PublicSettings) => void;
}

export function SettingsDialog({ settings, onClose, onSaved }: SettingsDialogProps) {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [model, setModel] = useState(settings.model);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt);
  const [temperature, setTemperature] = useState(String(settings.temperature));
  const [maxTokens, setMaxTokens] = useState(String(settings.maxTokens));
  const [topK, setTopK] = useState(String(settings.topK));
  const [contextChars, setContextChars] = useState(String(settings.contextChars));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const presetId = detectPreset(baseUrl);

  const buildDraft = (): SettingsDraft => {
    const draft: SettingsDraft = {
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      systemPrompt,
      temperature: Number(temperature),
      maxTokens: Number(maxTokens),
      topK: Number(topK),
      contextChars: Number(contextChars),
    };
    if (apiKey.trim()) draft.apiKey = apiKey.trim();
    if (clearApiKey) draft.clearApiKey = true;
    return draft;
  };

  const validate = (): string | null => {
    if (!/^https?:\/\//i.test(baseUrl.trim())) return 'Base URL 必须以 http:// 或 https:// 开头。';
    if (!model.trim()) return '模型名不能为空。';
    if (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2) {
      return 'temperature 必须在 0–2 之间。';
    }
    if (!Number.isInteger(Number(maxTokens)) || Number(maxTokens) < 16 || Number(maxTokens) > 8192) {
      return 'maxTokens 必须是 16–8192 的整数。';
    }
    if (!Number.isInteger(Number(topK)) || Number(topK) < 1 || Number(topK) > 20) {
      return 'topK 必须是 1–20 的整数。';
    }
    if (
      !Number.isInteger(Number(contextChars)) ||
      Number(contextChars) < 1000 ||
      Number(contextChars) > 50_000
    ) {
      return 'contextChars 必须是 1000–50000 的整数。';
    }
    return null;
  };

  const handlePreset = (id: PresetId) => {
    const preset = PRESETS.find((item) => item.id === id);
    if (!preset || preset.id === 'custom') return;
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
  };

  const handleTest = async () => {
    const validationError = validate();
    if (validationError) {
      setStatus({ kind: 'error', text: validationError });
      return;
    }
    setTesting(true);
    setStatus(null);
    try {
      const result = await testConnection(buildDraft());
      if (result.ok) {
        setStatus({
          kind: 'ok',
          text: `连接成功${result.latencyMs ? ` · ${result.latencyMs}ms` : ''}${
            result.model ? ` · ${result.model}` : ''
          }`,
        });
      } else {
        setStatus({ kind: 'error', text: `连接失败：${result.error ?? '未知错误'}` });
      }
    } catch (error) {
      setStatus({ kind: 'error', text: friendlyApiError(error) });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setStatus({ kind: 'error', text: validationError });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const next = await saveSettings(buildDraft());
      onSaved(next);
    } catch (error) {
      setStatus({ kind: 'error', text: friendlyApiError(error) });
    } finally {
      setSaving(false);
    }
  };

  const keyPlaceholder =
    settings.apiKeySource === 'env'
      ? '由环境变量 LLM_API_KEY 提供（环境变量优先，无需在这里填写）'
      : settings.hasApiKey
        ? `已保存（尾号 ${settings.apiKeyLast4 ?? '****'}），留空则保持不变`
        : '粘贴 API Key，仅保存在本机 data/settings.json';

  return (
    <div
      data-testid="settings-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3">
          <div>
            <div className="text-sm font-semibold">LLM 设置</div>
            <div className="text-[11px] text-slate-500">
              配置保存在本机服务端，API Key 不会回传到浏览器
            </div>
          </div>
          <button
            type="button"
            data-testid="settings-close"
            onClick={onClose}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100"
            aria-label="关闭设置"
          >
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-xs text-slate-600">
              <span className="mb-1 block font-medium text-slate-700">服务商预设</span>
              <select
                data-testid="provider-select"
                value={presetId}
                onChange={(event) => handlePreset(event.target.value as PresetId)}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
              >
                {PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[10px] text-slate-400">
                选择预设会自动填入 Base URL 与模型名，仍可手动修改。
              </span>
            </label>

            <label className="block text-xs text-slate-600">
              <span className="mb-1 block font-medium text-slate-700">模型</span>
              <input
                data-testid="settings-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="gpt-4o-mini / deepseek-chat / llama3.1"
                className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
              />
            </label>
          </div>

          <label className="block text-xs text-slate-600">
            <span className="mb-1 block font-medium text-slate-700">Base URL</span>
            <input
              data-testid="settings-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm outline-none focus:border-indigo-400"
            />
            <span className="mt-1 block text-[10px] text-slate-400">
              只填到 /v1 即可，服务端会自动补全 /chat/completions；完整路径也可直接填写。
            </span>
          </label>

          <label className="block text-xs text-slate-600">
            <span className="mb-1 block font-medium text-slate-700">API Key</span>
            <input
              data-testid="settings-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={keyPlaceholder}
              disabled={settings.apiKeySource === 'env'}
              className="w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-sm outline-none focus:border-indigo-400 disabled:bg-slate-100 disabled:text-slate-400"
            />
            {settings.hasApiKey && settings.apiKeySource === 'settings' && (
              <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-500">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(event) => setClearApiKey(event.target.checked)}
                  className="rounded border-slate-300"
                />
                清除已保存的 API Key
              </label>
            )}
            {settings.apiKeySource === 'env' && (
              <span className="mt-1 block text-[10px] text-amber-600">
                当前 Key 来自服务端环境变量 LLM_API_KEY，优先级高于设置页。
              </span>
            )}
          </label>

          <label className="block text-xs text-slate-600">
            <span className="mb-1 block font-medium text-slate-700">System Prompt</span>
            <textarea
              data-testid="settings-system-prompt"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              rows={4}
              className="w-full resize-y rounded-md border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
            />
            <span className="mt-1 block text-[10px] text-slate-400">
              服务端会在这段提示词后自动追加 5 条固定约束（只依据文档、[p.N] 引用、找不到就说未找到、忽略文档内指令、同语言回答）。
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <label className="block text-xs text-slate-600">
              <span className="mb-1 block font-medium text-slate-700">temperature</span>
              <input
                data-testid="settings-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={temperature}
                onChange={(event) => setTemperature(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
              />
            </label>
            <label className="block text-xs text-slate-600">
              <span className="mb-1 block font-medium text-slate-700">maxTokens</span>
              <input
                type="number"
                min={16}
                max={8192}
                step={16}
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
              />
            </label>
            <label className="block text-xs text-slate-600">
              <span className="mb-1 block font-medium text-slate-700">topK</span>
              <input
                data-testid="settings-topk"
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(event) => setTopK(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
              />
            </label>
            <label className="block text-xs text-slate-600">
              <span className="mb-1 block font-medium text-slate-700">contextChars</span>
              <input
                data-testid="settings-context-chars"
                type="number"
                min={1000}
                max={50000}
                step={500}
                value={contextChars}
                onChange={(event) => setContextChars(event.target.value)}
                className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm outline-none focus:border-indigo-400"
              />
            </label>
          </div>

          {status && (
            <div
              className={`flex items-start gap-1.5 rounded-md px-3 py-2 text-xs ${
                status.kind === 'ok'
                  ? 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              {status.kind === 'ok' ? (
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              ) : (
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
              )}
              <span className="break-all">{status.text}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          <button
            type="button"
            data-testid="settings-test"
            onClick={handleTest}
            disabled={testing || saving}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {testing && <Loader2 size={13} className="animate-spin" />}
            测试连接
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-200"
            >
              取消
            </button>
            <button
              type="button"
              data-testid="settings-save"
              onClick={handleSave}
              disabled={saving || testing}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              保存设置
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
