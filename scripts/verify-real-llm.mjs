#!/usr/bin/env node
// 真实服务商验收脚本：用你提供的 OpenAI 兼容服务，对 V4-relativity.pdf 的
// 第 1 页 OCR 文本做一次真实问答，并检查引用与 not_found 回退。
//
// 用法:
//   LLM_BASE_URL=https://api.openai.com/v1 \
//   LLM_MODEL=gpt-4o-mini \
//   LLM_API_KEY=your-key \
//   npm run verify:real
//
// 本地无鉴权的 OpenAI 兼容服务（如 Ollama）可省略 LLM_API_KEY。
//
// 可选:
//   VERIFY_PDF=/path/to/another-scanned.pdf
//   APP_PORT / API_PORT 目前固定为 5173 / 8787
//
// 行为:
//   1. 用临时 DATA_DIR（.verify-data）启动开发服务器，结束后删除，不把 key 留在仓库；
//   2. PUT /api/settings 保存服务商配置（key 只存在进程内的临时服务端，不打印）；
//   3. POST /api/settings/test 先验证服务商连通；
//   4. 用 Chrome 打开 V4，等第 1 页自动 OCR，问一个文档内问题和一个文档外问题；
//   5. 断言回答带可点击 [p.N]、文档外回答「未在文档中找到相关内容」；
//   6. 截图写入 artifacts/real-llm-*.png，结果写入 artifacts/real-llm-verification.json。
//
// 注意：任何时刻都不要把 LLM_API_KEY 写进日志、文件或截图。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const APP_URL = 'http://127.0.0.1:5173';
const API_URL = 'http://127.0.0.1:8787';
const DEFAULT_PDF = '/Users/Zhuanz/Documents/Physics/V4-relativity.pdf';

const baseUrl = (process.env.LLM_BASE_URL ?? '').trim().replace(/\/+$/, '');
const model = (process.env.LLM_MODEL ?? '').trim();
const apiKey = (process.env.LLM_API_KEY ?? '').trim();
const pdfPath = process.env.VERIFY_PDF ?? DEFAULT_PDF;
const dataDir = path.join(root, '.verify-data');
const artifactsDir = path.join(root, 'artifacts');

function fail(message) {
  console.error(`\n✘ 验收失败: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

if (!baseUrl || !model) {
  console.error(
    [
      '缺少真实服务商配置。用法:',
      '  LLM_BASE_URL=https://api.openai.com/v1 \\',
      '  LLM_MODEL=gpt-4o-mini \\',
      '  LLM_API_KEY=your-key \\',
      '  npm run verify:real',
      '',
      '本地无鉴权的 OpenAI 兼容服务（如 Ollama）可省略 LLM_API_KEY。',
      'LLM_API_KEY 只通过进程环境传入，不会写入仓库或日志。',
    ].join('\n'),
  );
  process.exit(2);
}
const apiKeyProvided = apiKey.length > 0;
if (!apiKeyProvided) {
  console.log('提示: 未提供 LLM_API_KEY，将按无鉴权的本地 OpenAI 兼容服务测试。');
}
if (!existsSync(pdfPath)) {
  console.error(`找不到测试 PDF: ${pdfPath}`);
  process.exit(2);
}

let providerHost = '';
try {
  providerHost = new URL(baseUrl).host;
} catch {
  console.error(`LLM_BASE_URL 不是合法 URL: ${baseUrl}`);
  process.exit(2);
}

let devProcess = null;
let browser = null;
const devLog = [];

function rememberDevLog(chunk) {
  devLog.push(chunk.toString());
  if (devLog.length > 80) devLog.shift();
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return response;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时: ${lastError}`);
}

async function waitForChatReady(page) {
  const input = page.getByTestId('chat-input');
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await input.isEnabled().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error('OCR 完成后聊天输入仍不可用（索引可能失败）');
}

async function ask(page, question, screenshotName) {
  const input = page.getByTestId('chat-input');
  const send = page.getByTestId('chat-send');
  const before = await page.getByTestId('chat-message-assistant').count();

  await input.fill(question);
  await send.click();

  let answer = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const count = await page.getByTestId('chat-message-assistant').count();
    if (count > before) {
      answer = page.getByTestId('chat-message-assistant').nth(count - 1);
      break;
    }
    await sleep(500);
  }
  if (!answer) throw new Error(`问题「${question}」在 180 秒内没有回答`);

  // 等待「生成中…」结束（输入框重新启用）再读文本/截图。
  const readyDeadline = Date.now() + 60_000;
  while (Date.now() < readyDeadline) {
    if (await input.isEnabled().catch(() => false)) break;
    await sleep(300);
  }
  await page.waitForTimeout(300);

  const text = (await answer.innerText()).trim();
  const citations = await answer.locator('[data-testid^="citation-p"]').allTextContents();
  await page.screenshot({ path: path.join(artifactsDir, screenshotName) });
  return { text, citations };
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  await rm(dataDir, { recursive: true, force: true });

  console.log(`[1/5] 启动开发服务器（临时 DATA_DIR=${path.relative(root, dataDir)}）…`);
  devProcess = spawn(process.execPath, ['scripts/dev.mjs'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'development' },
  });
  devProcess.stdout.on('data', rememberDevLog);
  devProcess.stderr.on('data', rememberDevLog);

  await waitForHttp(`${API_URL}/api/health`, 60_000);
  await waitForHttp(APP_URL, 60_000);

  console.log(`[2/5] 保存配置并测试连通: ${providerHost} / ${model}`);
  const saveResponse = await fetch(`${API_URL}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(apiKeyProvided ? { baseUrl, model, apiKey } : { baseUrl, model }),
  });
  if (!saveResponse.ok) {
    throw new Error(`保存设置失败 HTTP ${saveResponse.status}: ${await saveResponse.text()}`);
  }
  const saved = await saveResponse.json();
  assert(saved.hasApiKey === apiKeyProvided, `设置保存后 hasApiKey 应为 ${apiKeyProvided}`);
  assert(saved.baseUrl === baseUrl && saved.model === model, '设置保存后 baseUrl/model 未生效');

  const testResponse = await fetch(`${API_URL}/api/settings/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const testResult = await testResponse.json().catch(() => ({}));
  if (!testResponse.ok || testResult.ok !== true) {
    const detail = testResult?.error?.message ?? testResult?.error ?? `HTTP ${testResponse.status}`;
    throw new Error(`服务商连通测试失败: ${detail}`);
  }
  console.log(`      连接成功，延迟 ${testResult.latencyMs ?? '?'} ms，模型 ${testResult.model ?? model}`);

  console.log(`[3/5] Chrome 打开 V4 并等待第 1 页自动 OCR: ${pdfPath}`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('pdf-file-input').setInputFiles(pdfPath);
  await page.getByTestId('ocr-textarea').waitFor({ state: 'visible', timeout: 180_000 });
  await waitForChatReady(page);
  await page.getByTestId('notice').filter({ hasText: '已索引' }).waitFor({ timeout: 60_000 });
  const ocrSample = (await page.getByTestId('ocr-textarea').inputValue()).slice(0, 120);
  console.log(`      OCR 完成，文本开头: ${JSON.stringify(ocrSample)}`);

  console.log('[4/5] 文档内问题（期望真实回答 + 可点击 [p.N]）…');
  const inDoc = await ask(page, '这份文档的目录是什么？', 'real-llm-v4-answer.png');
  assert(!/未在文档中找到相关内容/.test(inDoc.text), '文档内问题被回答成 not_found');
  const citationPages = inDoc.citations
    .map((label) => /p\.(\d+)/.exec(label)?.[1])
    .filter(Boolean);
  assert(inDoc.citations.length > 0 && citationPages.length > 0, '文档内回答没有可点击的 [p.N] 引用');
  assert(
    citationPages.some((pageNumber) => Number(pageNumber) === 1),
    `引用页码不含第 1 页（OCR 页）：${inDoc.citations.join(', ')}`,
  );
  console.log(`      回答: ${inDoc.text.replace(/\s+/g, ' ').slice(0, 240)}`);
  console.log(`      引用: ${inDoc.citations.join(', ')}`);

  // 验证 [p.N] 确实可点击：点击第一个引用 chip，页码输入框应跳到对应页。
  const firstCitationPage = Number(citationPages[0]);
  await page.locator('[data-testid^="citation-p"]').first().click();
  const pageInput = page.getByTestId('page-input');
  const clickDeadline = Date.now() + 15_000;
  let currentPage = '';
  while (Date.now() < clickDeadline) {
    currentPage = await pageInput.inputValue();
    if (Number(currentPage) === firstCitationPage) break;
    await sleep(200);
  }
  assert(
    Number(currentPage) === firstCitationPage,
    `点击引用后页码未跳到第 ${firstCitationPage} 页（当前 ${currentPage}）`,
  );
  await page.screenshot({ path: path.join(artifactsDir, 'real-llm-v4-citation-click.png') });
  console.log(`      引用点击跳转验证: 第 ${firstCitationPage} 页`);

  console.log('[5/5] 文档外问题（期望 not_found）…');
  const outDoc = await ask(page, '文档是否提到量子引力？', 'real-llm-v4-not-found.png');
  assert(/未在文档中找到相关内容/.test(outDoc.text), '文档外问题没有返回「未在文档中找到相关内容」');
  assert(outDoc.citations.length === 0, '文档外回答不应带引用');
  console.log(`      回答: ${outDoc.text.replace(/\s+/g, ' ').slice(0, 240)}`);

  const result = {
    verifiedAt: new Date().toISOString(),
    providerHost,
    model,
    apiKeyProvided,
    pdf: pdfPath,
    ocrTextSample: ocrSample,
    inDocumentQuestion: '这份文档的目录是什么？',
    inDocumentAnswer: inDoc.text,
    inDocumentCitations: inDoc.citations,
    citationClickVerified: true,
    citationClickPage: firstCitationPage,
    outOfDocumentQuestion: '文档是否提到量子引力？',
    outOfDocumentAnswer: outDoc.text,
    screenshots: [
      'artifacts/real-llm-v4-answer.png',
      'artifacts/real-llm-v4-citation-click.png',
      'artifacts/real-llm-v4-not-found.png',
    ],
    passed: true,
  };
  await import('node:fs/promises').then(({ writeFile }) =>
    writeFile(path.join(artifactsDir, 'real-llm-verification.json'), `${JSON.stringify(result, null, 2)}\n`),
  );

  console.log('\n✔ 真实服务商验收通过');
  console.log(`  回答、引用点击与 not_found 证据已写入 artifacts/real-llm-verification.json`);
  console.log('  截图: artifacts/real-llm-v4-answer.png, artifacts/real-llm-v4-citation-click.png, artifacts/real-llm-v4-not-found.png');
}

function listDescendants(rootPid) {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map();
    for (const line of output.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid || Number.isNaN(ppid)) continue;
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const descendants = [];
    const stack = [rootPid];
    while (stack.length > 0) {
      const parent = stack.pop();
      for (const child of children.get(parent) ?? []) {
        descendants.push(child);
        stack.push(child);
      }
    }
    return descendants.reverse();
  } catch {
    return [];
  }
}

async function cleanup() {
  if (browser) await browser.close().catch(() => {});
  if (devProcess) {
    const descendants = listDescendants(devProcess.pid);
    try {
      process.kill(-devProcess.pid, 'SIGTERM');
    } catch {
      // already exited
    }
    await sleep(800);
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited
      }
    }
    try {
      process.kill(-devProcess.pid, 'SIGKILL');
    } catch {
      // already exited
    }
    try {
      process.kill(devProcess.pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
  await rm(dataDir, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (devLog.length) {
    console.error('\n--- dev server 日志（末 40 行）---');
    console.error(devLog.join('').split('\n').slice(-40).join('\n'));
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}

process.exit(process.exitCode ?? 0);
