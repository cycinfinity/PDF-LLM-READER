#!/usr/bin/env node
// 批量把扫描 PDF 转成带文字层的文本 PDF。
//
// 原理与界面里的「转换为文本 PDF」完全一致：浏览器本地 OCR → pdf-lib 叠加不可见文字层。
// 区别是脚本会自动按 CHUNK 页分段、每段后关闭并重开导出弹窗（回收 OCR worker），
// 最后用 pdf-lib 合并成一个 PDF；适合界面一次转换整本会因浏览器内存卡死的长扫描书。
//
// 用法:
//   PDF_PATH=/path/book.pdf npm run convert:pdf
//   PDF_PATH=/path/book.pdf MODE=all CHUNK=30 npm run convert:pdf
//   PDF_PATH=/path/book.pdf PAGES=1-10 OUT_PDF=artifacts/sample.pdf npm run convert:pdf
//
// 可选环境变量: MODE(high|all, 默认 high)、CHUNK(默认 30)、THRESHOLD(50-99, 默认 80)、
//              PAGES(如 1-10)、OUT_PDF(默认 artifacts/<name>-text.pdf)
// 不需要 API Key；OCR 在本机浏览器执行。

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const root = fileURLToPath(new URL('..', import.meta.url));
const APP_URL = 'http://127.0.0.1:5173';
const API_URL = 'http://127.0.0.1:8787';
const pdfPath = path.resolve(process.env.PDF_PATH ?? '');
const mode = (process.env.MODE ?? 'high').toLowerCase();
const chunkSize = Math.max(1, Number(process.env.CHUNK ?? 30));
const threshold = Math.max(50, Math.min(99, Number(process.env.THRESHOLD ?? 80)));
const pagesSpec = (process.env.PAGES ?? '').trim();
const dataDir = path.join(root, '.convert-data');
const tmpDir = path.join(root, '.convert-tmp');
const outPath = path.resolve(
  root,
  process.env.OUT_PDF ?? `artifacts/${path.basename(pdfPath, '.pdf')}-text.pdf`,
);

function fail(message) {
  console.error(`\n✘ 批量转换失败: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function parsePages(spec, pageCount) {
  if (!spec) return { from: 1, to: pageCount };
  const match = /^(\d+)(?:-(\d+))?$/.exec(spec);
  if (!match) fail(`PAGES 格式应为 1-10 或 5，收到: ${spec}`);
  const from = Number(match[1]);
  const to = match[2] ? Number(match[2]) : from;
  if (from < 1 || to < from || to > pageCount) {
    fail(`PAGES ${spec} 超出 1-${pageCount}`);
  }
  return { from, to };
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

let devProcess = null;
let browser = null;

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
  await rm(tmpDir, { recursive: true, force: true });
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

async function alreadyRunning() {
  try {
    const response = await fetch(`${API_URL}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function setThreshold(page, value) {
  await page.getByTestId('export-threshold').evaluate((element, next) => {
    const input = element;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(next));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function main() {
  if (!pdfPath || !existsSync(pdfPath)) {
    console.error('用法: PDF_PATH=/path/book.pdf [MODE=high|all] [CHUNK=30] [PAGES=1-10] npm run convert:pdf');
    process.exit(2);
  }
  if (mode !== 'high' && mode !== 'all') fail(`MODE 只能是 high 或 all，收到: ${mode}`);

  await mkdir(tmpDir, { recursive: true });
  await mkdir(path.dirname(outPath), { recursive: true });
  await rm(dataDir, { recursive: true, force: true });

  const externalServer = await alreadyRunning();
  if (!externalServer) {
    console.log('[1/5] 启动开发服务器（临时 DATA_DIR）…');
    devProcess = spawn(process.execPath, ['scripts/dev.mjs'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'development' },
    });
    await waitForHttp(`${API_URL}/api/health`, 60_000);
    await waitForHttp(APP_URL, 60_000);
  } else {
    console.log('[1/5] 复用已运行的开发服务器');
  }

  console.log(`[2/5] 打开 PDF: ${pdfPath}（模式 ${mode}，阈值 ${threshold}，每段 ${chunkSize} 页）`);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('pdf-file-input').setInputFiles(pdfPath);
  await page.getByTestId('export-button').waitFor({ state: 'visible', timeout: 120_000 });
  await page.waitForTimeout(1500); // 让自动 OCR 完成当前页，避免和导出抢 worker
  const header = await page.locator('header').innerText();
  const pageCount = Number(/(\d+)\s*页/.exec(header)?.[1] ?? 0);
  if (!pageCount) fail(`没有从页面标题读到页数: ${header}`);
  const range = parsePages(pagesSpec, pageCount);
  console.log(`      页数 ${pageCount}，转换范围 ${range.from}–${range.to}`);

  const chunks = [];
  for (let from = range.from; from <= range.to; from += chunkSize) {
    chunks.push({ from, to: Math.min(range.to, from + chunkSize - 1) });
  }
  console.log(`[3/5] 分 ${chunks.length} 段转换…`);

  const chunkResults = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const label = `第 ${index + 1}/${chunks.length} 段（${chunk.from}–${chunk.to} 页）`;

    await page.getByTestId('export-button').click();
    await page.getByTestId('export-dialog').waitFor({ state: 'visible', timeout: 30_000 });
    if (mode === 'all') await page.getByTestId('export-mode-all').check();
    else await page.getByTestId('export-mode-high').check();
    if (mode === 'high') await setThreshold(page, threshold);
    await page.getByTestId('export-page-from').fill(String(chunk.from));
    await page.getByTestId('export-page-to').fill(String(chunk.to));
    await page.getByTestId('export-start').click();

    try {
      await page.getByTestId('export-result').waitFor({ state: 'visible', timeout: 300_000 });
    } catch {
      const dialogText = await page.getByTestId('export-dialog').innerText().catch(() => '');
      fail(`${label} 超时未完成。弹窗内容: ${dialogText.split('\n').slice(-6).join(' | ')}`);
    }
    const resultText = (await page.getByTestId('export-result').innerText()).replace(/\s+/g, ' ');
    const chunkPath = path.join(tmpDir, `chunk-${String(index).padStart(2, '0')}.pdf`);
    const downloadPromise = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('export-download').click();
    const download = await downloadPromise;
    await download.saveAs(chunkPath);
    await page.getByTestId('export-close').click();
    await page.getByTestId('export-dialog').waitFor({ state: 'hidden', timeout: 15_000 });

    chunkResults.push({ ...chunk, path: chunkPath, resultText });
    console.log(`      ${label} 完成: ${resultText}`);
  }

  console.log(`[4/5] 合并 ${chunks.length} 段 → ${path.relative(root, outPath)}`);
  const merged = await PDFDocument.create();
  for (const chunk of chunkResults) {
    const bytes = await readFile(chunk.path);
    const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await merged.copyPages(document, document.getPageIndices());
    for (const copiedPage of copied) merged.addPage(copiedPage);
  }
  const mergedBytes = await merged.save();
  await writeFile(outPath, mergedBytes);

  console.log('[5/5] 校验文字层…');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(mergedBytes), disableWorker: true }).promise;
  let textPages = 0;
  let totalChars = 0;
  for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
    const textPage = await loaded.getPage(pageNumber);
    const content = await textPage.getTextContent();
    const chars = content.items.reduce((sum, item) => sum + ('str' in item ? item.str.length : 0), 0);
    if (chars > 0) textPages += 1;
    totalChars += chars;
  }

  console.log('\n✔ 批量转换完成');
  console.log(`  输出: ${outPath}（${(mergedBytes.length / 1024 / 1024).toFixed(1)} MB）`);
  console.log(`  文字层: ${textPages} / ${loaded.numPages} 页，${totalChars.toLocaleString('en-US')} 字符`);
  console.log(`  分段结果: ${chunkResults.map((chunk) => `${chunk.from}-${chunk.to}`).join(', ')}`);
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}

process.exit(process.exitCode ?? 0);
