import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1680, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 20_000,
  },
  webServer: [
    {
      command: 'npx tsx e2e/mock-llm.ts',
      url: 'http://127.0.0.1:9999/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // 用户项目根目录可能已有 .env；显式覆盖为 mock LLM，避免 E2E 打到真实服务商。
      command:
        'rm -rf .e2e-data && DATA_DIR=.e2e-data LLM_BASE_URL=http://127.0.0.1:9999/v1 LLM_MODEL=mock-model LLM_API_KEY= npx tsx server/index.ts',
      url: 'http://127.0.0.1:8787/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'] } }],
});
