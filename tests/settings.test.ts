import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsStore, settingsPatchSchema } from '../server/settings';

let tempDir: string;
let settingsPath: string;
let store: SettingsStore;

const originalEnv = {
  LLM_API_KEY: process.env.LLM_API_KEY,
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
};

beforeEach(() => {
  // 项目根目录可能存在 .env（用户真实配置），测试必须与这些覆盖隔离。
  delete process.env.LLM_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-llm-settings-'));
  settingsPath = path.join(tempDir, 'settings.json');
  store = new SettingsStore(settingsPath);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('SettingsStore', () => {
  it('returns defaults when no settings file exists', () => {
    const loaded = store.load();
    expect(loaded.model).toBe('gpt-4o-mini');
    expect(loaded.apiKey).toBe('');
    expect(store.publicSettings()).toMatchObject({
      hasApiKey: false,
      apiKeyLast4: null,
      apiKeySource: 'none',
    });
  });

  it('persists settings with 0600 permissions and masks the key publicly', () => {
    store.update({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'test-key-abcdef123456',
      systemPrompt: '自定义提示词',
    });

    const reloaded = new SettingsStore(settingsPath);
    const loaded = reloaded.load();
    expect(loaded.model).toBe('deepseek-chat');
    expect(loaded.apiKey).toBe('test-key-abcdef123456');
    expect(loaded.systemPrompt).toBe('自定义提示词');

    const publicSettings = reloaded.publicSettings();
    expect(publicSettings.hasApiKey).toBe(true);
    expect(publicSettings.apiKeyLast4).toBe('3456');
    expect(publicSettings.apiKeySource).toBe('settings');
    expect(JSON.stringify(publicSettings)).not.toContain('test-key-abcdef123456');
    expect(JSON.stringify(publicSettings)).not.toContain('apiKey"');

    const mode = fs.statSync(settingsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('keeps the existing key when the patch omits it, and can clear it', () => {
    store.update({ apiKey: 'test-key-stored-9999' });
    store.update({ model: 'another-model' });
    expect(store.load().apiKey).toBe('test-key-stored-9999');

    store.update({ clearApiKey: true });
    expect(store.load().apiKey).toBe('');
    expect(store.publicSettings().hasApiKey).toBe(false);
  });

  it('lets environment variables override stored values', () => {
    store.update({ baseUrl: 'https://stored.example/v1', model: 'stored-model', apiKey: 'test-key-stored-1234' });

    process.env.LLM_BASE_URL = 'https://env.example/v1';
    process.env.LLM_MODEL = 'env-model';
    process.env.LLM_API_KEY = 'test-key-env-123456';

    const effective = store.effective();
    expect(effective.baseUrl).toBe('https://env.example/v1');
    expect(effective.model).toBe('env-model');
    expect(effective.apiKey).toBe('test-key-env-123456');
    expect(effective.apiKeySource).toBe('env');

    const publicSettings = store.publicSettings();
    expect(publicSettings.apiKeyLast4).toBe('3456');
    expect(publicSettings.apiKeySource).toBe('env');
  });
});

describe('settingsPatchSchema', () => {
  it('accepts known fields', () => {
    expect(settingsPatchSchema.safeParse({ model: 'gpt-4o-mini', topK: 5 }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(settingsPatchSchema.safeParse({ unknown: true }).success).toBe(false);
  });

  it('rejects an invalid base URL and out-of-range numbers', () => {
    expect(settingsPatchSchema.safeParse({ baseUrl: 'ftp://example.com' }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ temperature: 3 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ topK: 0 }).success).toBe(false);
  });
});
