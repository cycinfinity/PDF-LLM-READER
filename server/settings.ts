import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SETTINGS_PATH } from './config';

export type ApiKeySource = 'none' | 'settings' | 'env';

export interface StoredSettings {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  topK: number;
  contextChars: number;
  apiKey: string;
}

export type EffectiveSettings = StoredSettings & { apiKeySource: ApiKeySource };

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

export const DEFAULT_SYSTEM_PROMPT = `你是一名严谨的文档问答助手，负责根据用户提供的 PDF 文档摘录回答问题。`;

export const DEFAULT_SETTINGS: StoredSettings = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  temperature: 0.2,
  maxTokens: 1024,
  topK: 6,
  contextChars: 6000,
  apiKey: '',
};

const baseUrlSchema = z
  .string()
  .trim()
  .min(1, 'Base URL 不能为空')
  .max(500, 'Base URL 过长')
  .refine((value) => /^https?:\/\//i.test(value), 'Base URL 必须以 http:// 或 https:// 开头');

export const settingsPatchSchema = z
  .object({
    baseUrl: baseUrlSchema.optional(),
    model: z.string().trim().min(1, '模型名不能为空').max(200).optional(),
    systemPrompt: z.string().max(20_000, 'system prompt 过长').optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(16).max(8192).optional(),
    topK: z.number().int().min(1).max(20).optional(),
    contextChars: z.number().int().min(1000).max(50_000).optional(),
    apiKey: z.string().max(500).optional(),
    clearApiKey: z.boolean().optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeStored(value: Partial<StoredSettings>): StoredSettings {
  const merged = { ...DEFAULT_SETTINGS, ...value };
  return {
    baseUrl: typeof merged.baseUrl === 'string' && merged.baseUrl.trim() ? merged.baseUrl.trim() : DEFAULT_SETTINGS.baseUrl,
    model: typeof merged.model === 'string' && merged.model.trim() ? merged.model.trim() : DEFAULT_SETTINGS.model,
    systemPrompt:
      typeof merged.systemPrompt === 'string' ? merged.systemPrompt.slice(0, 20_000) : DEFAULT_SETTINGS.systemPrompt,
    temperature: clamp(Number(merged.temperature), 0, 2, DEFAULT_SETTINGS.temperature),
    maxTokens: Math.round(clamp(Number(merged.maxTokens), 16, 8192, DEFAULT_SETTINGS.maxTokens)),
    topK: Math.round(clamp(Number(merged.topK), 1, 20, DEFAULT_SETTINGS.topK)),
    contextChars: Math.round(clamp(Number(merged.contextChars), 1000, 50_000, DEFAULT_SETTINGS.contextChars)),
    apiKey: typeof merged.apiKey === 'string' ? merged.apiKey.trim() : '',
  };
}

function maskLast4(apiKey: string): string | null {
  return apiKey.length >= 4 ? apiKey.slice(-4) : null;
}

export class SettingsStore {
  constructor(private readonly filePath: string = SETTINGS_PATH) {}

  load(): StoredSettings {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredSettings>;
      return sanitizeStored(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[settings] 无法读取 settings.json，已回退到默认配置。');
      }
      return { ...DEFAULT_SETTINGS };
    }
  }

  save(settings: StoredSettings): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    fs.chmodSync(this.filePath, 0o600);
  }

  update(patch: SettingsPatch): StoredSettings {
    const current = this.load();
    const next: StoredSettings = { ...current };

    if (patch.baseUrl !== undefined) next.baseUrl = patch.baseUrl.trim();
    if (patch.model !== undefined) next.model = patch.model.trim();
    if (patch.systemPrompt !== undefined) next.systemPrompt = patch.systemPrompt;
    if (patch.temperature !== undefined) next.temperature = patch.temperature;
    if (patch.maxTokens !== undefined) next.maxTokens = patch.maxTokens;
    if (patch.topK !== undefined) next.topK = patch.topK;
    if (patch.contextChars !== undefined) next.contextChars = patch.contextChars;

    if (patch.clearApiKey) {
      next.apiKey = '';
    } else if (typeof patch.apiKey === 'string' && patch.apiKey.trim().length > 0) {
      next.apiKey = patch.apiKey.trim();
    }

    const sanitized = sanitizeStored(next);
    this.save(sanitized);
    return sanitized;
  }

  /** Merge stored settings with server-side environment overrides. */
  effective(): EffectiveSettings {
    const stored = this.load();
    const envKey = process.env.LLM_API_KEY?.trim() ?? '';
    const envBaseUrl = process.env.LLM_BASE_URL?.trim() ?? '';
    const envModel = process.env.LLM_MODEL?.trim() ?? '';

    const apiKey = envKey || stored.apiKey;
    return {
      ...stored,
      baseUrl: envBaseUrl || stored.baseUrl,
      model: envModel || stored.model,
      apiKey,
      apiKeySource: envKey ? 'env' : stored.apiKey ? 'settings' : 'none',
    };
  }

  publicSettings(): PublicSettings {
    const effective = this.effective();
    return {
      baseUrl: effective.baseUrl,
      model: effective.model,
      systemPrompt: effective.systemPrompt,
      temperature: effective.temperature,
      maxTokens: effective.maxTokens,
      topK: effective.topK,
      contextChars: effective.contextChars,
      hasApiKey: effective.apiKey.length > 0,
      apiKeyLast4: maskLast4(effective.apiKey),
      apiKeySource: effective.apiKeySource,
    };
  }
}
