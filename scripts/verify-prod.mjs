#!/usr/bin/env node
// 生产构建 smoke：启动 node dist-server/index.js + 进程内 mock OpenAI 兼容服务 + Chrome，
// 验证生产模式下的静态资产、V4 自动 OCR、问答、引用跳页与 not_found 回退。
//
// 用法:
//   npm run build
//   npm run verify:prod
//
// 可选:
//   VERIFY_PDF=/path/to/another-scanned.pdf

import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const APP_PORT = 8899;
const MOCK_PORT = 9999;
const APP = `http://127.0.0.1:${APP_PORT}`;
const DEFAULT_PDF = '/Users/Zhuanz/Documents/Physics/V4-relativity.pdf';
const pdfPath = process.env.VERIFY_PDF ?? DEFAULT_PDF;
const dataDir = path.join(root, '.prod-data');
const artifactsDir = path.join(root, 'artifacts');

function fail(message) {
  console.error(`\n✘ 生产 smoke 失败: ${message}`);
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

if (!existsSync(path.join(root, 'dist/index.html')) || !existsSync(path.join(root, 'dist-server/index.js'))) {
  console.error('找不到生产构建产物。请先运行 npm run build。');
  process.exit(2);
}
if (!existsSync(pdfPath)) {
  console.error(`找不到测试 PDF: ${pdfPath}`);
  process.exit(2);
}

let server = null;
let mock = null;
let browser = null;
const serverLog = [];

function remember(chunk) {
  serverLog.push(chunk.toString());
  if (serverLog.length > 80) serverLog.shift();
}

function createMockLlm() {
  return http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (request.method === 'POST' && request.url?.includes('/chat/completions')) {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
          payload = {};
        }
        const userText = Array.isArray(payload.messages)
          ? payload.messages
              .filter((message) => message?.role === 'user')
              .map((message) => String(message.content ?? ''))
              .join('\n')
          : '';
        const content = userText.includes('量子引力')
          ? '未在文档中找到相关内容。'
          : '这份文档是物理教材的目录，涵盖狭义相对论与量子力学等章节 [p.1]。';
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'mock-completion',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model ?? 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          }),
        );
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
  });
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
  if (server) {
    const descendants = listDescendants(server.pid);
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      // already exited
    }
    await sleep(600);
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already exited
      }
    }
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // already exited
    }
  }
  if (mock) await new Promise((resolve) => mock.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}

async function ask(page, question, answerIndex) {
  await page.getByTestId('chat-input').fill(question);
  await page.getByTestId('chat-send').click();
  await page.getByTestId('chat-message-assistant').nth(answerIndex).waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="chat-input"]')?.disabled !== true,
    undefined,
    { timeout: 60_000 },
  );
  return (await page.getByTestId('chat-message-assistant').nth(answerIndex).innerText()).trim();
}

async function main() {
  await mkdir(artifactsDir, { recursive: true });
  await rm(dataDir, { recursive: true, force: true });

  console.log(`[1/5] 启动 mock LLM (127.0.0.1:${MOCK_PORT}) 与生产服务器 (127.0.0.1:${APP_PORT})…`);
  mock = createMockLlm();
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(MOCK_PORT, '127.0.0.1', resolve);
  });
  server = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Production smoke uses its local mock; never let a user .env reach a real provider.
      LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      LLM_MODEL: 'mock-model',
      LLM_API_KEY: '',
      PORT: String(APP_PORT),
      DATA_DIR: dataDir,
      NODE_ENV: 'production',
    },
  });
  server.stdout.on('data', remember);
  server.stderr.on('data', remember);

  const health = await (await waitForHttp(`${APP}/api/health`, 60_000)).json();
  assert(health.ok === true, '生产 health 不 ok');
  console.log(`      health: ${JSON.stringify(health)}`);

  console.log('[2/5] 静态资产检查…');
  for (const asset of ['/pdfjs/wasm/jbig2.wasm', '/ocr/worker.min.js', '/ocr/lang/eng.traineddata.gz']) {
    const response = await fetch(`${APP}${asset}`);
    assert(response.ok, `静态资产不可用: ${asset}`);
    console.log(`      ${asset} 200 ${(await response.arrayBuffer()).byteLength}`);
  }

  console.log('[3/5] 配置无 Key 的本机服务并打开 V4…');
  const saved = await fetch(`${APP}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model' }),
  }).then((response) => response.json());
  assert(saved.hasApiKey === false, '无 Key 设置后 hasApiKey 应为 false');
  assert(saved.baseUrl === `http://127.0.0.1:${MOCK_PORT}/v1`, 'baseUrl 未生效');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('pdf-file-input').setInputFiles(pdfPath);
  await page.getByTestId('ocr-textarea').waitFor({ state: 'visible', timeout: 180_000 });
  await page.getByTestId('notice').filter({ hasText: '已索引' }).waitFor({ timeout: 60_000 });
  const renderedPage = await page.getByTestId('pdf-scroll').getAttribute('data-rendered-page');
  assert(renderedPage === '1', `PDF 第 1 页未渲染: ${renderedPage}`);
  const ocrValue = await page.getByTestId('ocr-textarea').inputValue();
  assert(ocrValue.includes('CONTENTS'), `OCR 内容异常: ${ocrValue.slice(0, 80)}`);
  assert(await page.getByTestId('chat-input').isEnabled(), 'OCR 后聊天输入未启用');
  console.log(`      OCR 完成，${ocrValue.trim().length} 字符，聊天已启用`);

  console.log('[4/5] 文档内问答 + 引用点击…');
  const answer = await ask(page, '这份文档的目录是什么？', 0);
  assert(answer.includes('[p.1]'), `生产问答缺少 [p.1]: ${answer}`);
  await page.getByTestId('chat-message-assistant').first().locator('[data-testid^="citation-p"]').first().click();
  const deadline = Date.now() + 15_000;
  let currentPage = '';
  while (Date.now() < deadline) {
    currentPage = await page.getByTestId('page-input').inputValue();
    if (currentPage === '1') break;
    await sleep(200);
  }
  assert(currentPage === '1', `点击引用后页码未跳到第 1 页（当前 ${currentPage}）`);
  await page.screenshot({ path: path.join(artifactsDir, 'prod-smoke-answer.png') });
  console.log(`      回答: ${answer.replace(/\s+/g, ' ').slice(0, 160)}`);
  console.log('      引用点击跳到第 1 页');

  console.log('[5/5] 文档外问答（期望 not_found）…');
  const notFound = await ask(page, '文档是否提到量子引力？', 1);
  assert(notFound.includes('未在文档中找到相关内容'), `生产 not_found 异常: ${notFound}`);
  await page.screenshot({ path: path.join(artifactsDir, 'prod-smoke-not-found.png') });
  console.log(`      回答: ${notFound.replace(/\s+/g, ' ').slice(0, 160)}`);

  const result = {
    verifiedAt: new Date().toISOString(),
    mode: 'production (dist-server/index.js, NODE_ENV=production)',
    health,
    staticAssets: ['/pdfjs/wasm/jbig2.wasm', '/ocr/worker.min.js', '/ocr/lang/eng.traineddata.gz'],
    pdf: pdfPath,
    ocrFirstPageChars: ocrValue.trim().length,
    chatEnabledWithoutApiKey: true,
    answer,
    citationClickPage: 1,
    notFoundAnswer: notFound,
    screenshots: ['artifacts/prod-smoke-answer.png', 'artifacts/prod-smoke-not-found.png'],
    passed: true,
  };
  await writeFile(path.join(artifactsDir, 'prod-smoke.json'), `${JSON.stringify(result, null, 2)}\n`);

  console.log('\n✔ 生产模式 smoke 通过');
  console.log('  证据: artifacts/prod-smoke.json、artifacts/prod-smoke-answer.png、artifacts/prod-smoke-not-found.png');
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  if (serverLog.length) {
    console.error('\n--- 生产服务器日志（末 30 行）---');
    console.error(serverLog.join('').split('\n').slice(-30).join('\n'));
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}

process.exit(process.exitCode ?? 0);
