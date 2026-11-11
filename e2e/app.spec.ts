import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { makeLongTextPdf, makeScannedPdf, makeTextPdf } from './fixtures';

const PDF_PATH = '/Users/Zhuanz/Documents/Physics/V4-relativity.pdf';
const SHOTS = 'artifacts';

test.describe.configure({ mode: 'serial' });

/** Previous tests may have persisted a session; clear it before asserting the empty state. */
async function clearSession(page: Page): Promise<void> {
  await page.request.delete('http://127.0.0.1:8787/api/session');
}

async function loadV4(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('pdf-file-input').setInputFiles(PDF_PATH);
  await expect(page.getByTestId('pdf-canvas')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '1', {
    timeout: 120_000,
  });
  await expect(page.locator('header')).toContainText('V4-relativity.pdf');
  await expect(page.locator('header')).toContainText('286 页', { timeout: 120_000 });
}

async function waitForOcrText(page: Page, minimum = 100): Promise<void> {
  await page.waitForFunction(
    (min) => {
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="ocr-textarea"]');
      return Boolean(textarea && textarea.value.trim().length >= min);
    },
    minimum,
    { timeout: 180_000 },
  );
  await expect(page.getByTestId('ocr-panel')).toBeVisible();
}

async function pinchOut(page: Page): Promise<void> {
  await page.getByTestId('pdf-scroll').evaluate((element) => {
    const target = element as HTMLElement;
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const fire = (type: string, pointerId: number, x: number, y: number) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: 'touch',
          isPrimary: pointerId === 11,
          clientX: x,
          clientY: y,
        }),
      );
    };
    fire('pointerdown', 11, cx - 80, cy);
    fire('pointerdown', 12, cx + 80, cy);
    fire('pointermove', 11, cx - 160, cy);
    fire('pointermove', 12, cx + 160, cy);
    fire('pointerup', 11, cx - 160, cy);
    fire('pointerup', 12, cx + 160, cy);
  });
}

test('settings persist across reload and the API key is masked', async ({ page }) => {
  await clearSession(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();

  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByTestId('settings-base-url').fill('http://127.0.0.1:9999/v1');
  await page.getByTestId('settings-model').fill('mock-model');
  await page.getByTestId('settings-api-key').fill('test-key-e2e-test-123456');
  await page.getByTestId('settings-system-prompt').fill('你是测试助手，只依据文档回答。');
  await page.getByTestId('settings-test').click();
  await expect(page.getByText('连接成功')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/e2e-settings.png` });

  await page.getByTestId('settings-save').click();
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
  await expect(page.getByTestId('notice')).toContainText('设置已保存');

  await page.reload();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-model')).toHaveValue('mock-model');
  await expect(page.getByTestId('settings-base-url')).toHaveValue('http://127.0.0.1:9999/v1');
  await expect(page.getByTestId('settings-system-prompt')).toHaveValue('你是测试助手，只依据文档回答。');
  await expect(page.getByTestId('settings-api-key')).toHaveValue('');
  await expect(page.getByTestId('settings-api-key')).toHaveAttribute('placeholder', /尾号 3456/);
  await page.getByTestId('settings-close').click();
});

test('OCR, editing, arrow-key paging, pinch zoom and grounded Q&A on the scanned PDF', async ({
  page,
  request,
}) => {
  test.setTimeout(360_000);
  await clearSession(page);
  await loadV4(page);
  await waitForOcrText(page);

  // OCR output really is the CONTENTS page of the scanned book.
  await expect(page.getByTestId('ocr-textarea')).toHaveValue(/CONTENTS|Special Relativity/i);
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('ocr-status')).toContainText('OCR 完成', { timeout: 60_000 });
  await expect(page.getByTestId('notice')).toContainText('已索引', { timeout: 60_000 });
  const canvasWidth = await page
    .getByTestId('pdf-canvas')
    .evaluate((element) => (element as HTMLCanvasElement).width);
  expect(canvasWidth).toBeGreaterThan(300);
  await page.screenshot({ path: `${SHOTS}/e2e-v4-ocr-page1.png` });

  // Editing stays in the page text across navigation (in-memory, current session).
  const ocrText = page.getByTestId('ocr-textarea');
  const original = await ocrText.inputValue();
  await ocrText.fill(`${original}\nEDITED-PAGE1-MARKER`);
  await page.waitForTimeout(1000);

  // Arrow keys page the PDF when focus is not inside an editable control.
  await page.getByTestId('pdf-scroll').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('page-input')).toHaveValue('2');
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '2');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('page-input')).toHaveValue('1');
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '1');
  await expect(ocrText).toHaveValue(/EDITED-PAGE1-MARKER/);

  // Guard: page box, chat box and OCR textarea must not trigger paging.
  await page.getByTestId('page-input').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('page-input')).toHaveValue('1');
  await page.getByTestId('chat-input').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('page-input')).toHaveValue('1');
  await ocrText.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('page-input')).toHaveValue('1');

  // Pinch only scales the PDF stage; the LLM sidebar keeps its size.
  const beforePinch = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"]')!;
    const chat = document.querySelector<HTMLElement>('[data-testid="chat-panel"]')!;
    return {
      canvasWidth: canvas.getBoundingClientRect().width,
      chatFontSize: getComputedStyle(chat).fontSize,
      chatWidth: chat.getBoundingClientRect().width,
    };
  });
  await pinchOut(page);
  // The pinch factor is relative to the current fit-width scale, so the zoom
  // percentage depends on the page size; assert it became an explicit zoom.
  const zoomAfterPinch = Number(await page.getByTestId('zoom-select').inputValue());
  expect(zoomAfterPinch).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  const afterPinch = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="pdf-canvas"]')!;
    const chat = document.querySelector<HTMLElement>('[data-testid="chat-panel"]')!;
    return {
      canvasWidth: canvas.getBoundingClientRect().width,
      chatFontSize: getComputedStyle(chat).fontSize,
      chatWidth: chat.getBoundingClientRect().width,
    };
  });
  expect(afterPinch.canvasWidth).toBeGreaterThan(beforePinch.canvasWidth);
  expect(afterPinch.chatFontSize).toBe(beforePinch.chatFontSize);
  expect(afterPinch.chatWidth).toBe(beforePinch.chatWidth);

  // Ask about the OCR'd page: the gateway must receive OCR text and cite [p.1].
  await page.getByTestId('chat-input').fill('这份文档的目录是什么？');
  await page.getByTestId('chat-send').click();
  const assistantMessages = page.getByTestId('chat-message-assistant');
  await expect(assistantMessages).toHaveCount(1);
  await expect(assistantMessages.first()).toContainText('目录');
  await expect(page.getByTestId('citation-p1')).toBeVisible();

  const lastRequest = (await (
    await request.get('http://127.0.0.1:9999/last-request')
  ).json()) as { messages?: Array<{ role: string; content: string }> };
  const systemMessage = lastRequest.messages?.find((message) => message.role === 'system');
  const userMessage = lastRequest.messages?.find((message) => message.role === 'user');
  expect(systemMessage?.content).toContain('你是测试助手，只依据文档回答。');
  expect(userMessage?.content).toContain('CONTENTS');
  expect(userMessage?.content).toMatch(/<pages? \d/);
  await page.screenshot({ path: `${SHOTS}/e2e-v4-ocr-answer.png` });

  // Out-of-document question must fall back to not-found.
  await page.getByTestId('chat-input').fill('文档是否提到量子引力？');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(2);
  await expect(assistantMessages.nth(1)).toContainText('未在文档中找到相关内容');
  await expect(assistantMessages.nth(1).getByTestId('citation-p1')).toHaveCount(0);

  // Wait for the debounced session + chat archive writes to reach the server
  // before reloading, otherwise the reload races the 500ms persistence debounce.
  await page.waitForTimeout(1200);
  const sessionForChat = (await (
    await request.get('http://127.0.0.1:8787/api/session')
  ).json()) as { docId: string; page: number };
  expect(sessionForChat.page).toBe(1);
  const chatsBeforeReload = (await (
    await request.get(`http://127.0.0.1:8787/api/documents/${sessionForChat.docId}/chats`)
  ).json()) as { chats: Array<{ id: string; messageCount: number }> };
  // One archived conversation; each exchange stores one user + one assistant entry.
  expect(chatsBeforeReload.chats).toHaveLength(1);
  expect(chatsBeforeReload.chats[0].messageCount).toBe(4);
  const archivedChatId = chatsBeforeReload.chats[0].id;

  // Refresh restores the same V4 PDF, its page and the edited OCR text, but
  // starts a fresh conversation; the old one is reachable from history.
  await page.screenshot({ path: `${SHOTS}/e2e-v4-restore-before.png` });
  await page.reload();
  await expect(page.locator('header')).toContainText('V4-relativity.pdf', { timeout: 60_000 });
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '1', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('ocr-textarea')).toHaveValue(/EDITED-PAGE1-MARKER/, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('notice')).toContainText('已开启新对话');
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0, { timeout: 60_000 });

  // Open the archived conversation from the history menu.
  await page.getByTestId('chat-history-toggle').click();
  await expect(page.getByTestId('chat-history-panel')).toBeVisible();
  await expect(page.getByTestId(`chat-history-item-${archivedChatId}`)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/e2e-v4-history-list.png` });
  await page.getByTestId(`chat-history-item-${archivedChatId}`).click();
  await expect(page.getByTestId('chat-history-banner')).toBeVisible();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.getByTestId('chat-message-user')).toHaveCount(2);
  await page.getByTestId('fit-width').click();
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '1');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/e2e-v4-restore-after.png` });

  // Returning to the current conversation shows it is still empty.
  await page.getByTestId('chat-history-exit').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0);
});

test('exports an OCR text-layer PDF and re-indexes it without OCR', async ({ page, request }) => {
  test.setTimeout(360_000);
  const scannedPdf = await makeScannedPdf(page);

  await clearSession(page);
  await page.goto('/');
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'scanned-2p.pdf',
    mimeType: 'application/pdf',
    buffer: scannedPdf,
  });
  await waitForOcrText(page, 50);
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 60_000 });

  const ocrText = page.getByTestId('ocr-textarea');
  await ocrText.fill(`${await ocrText.inputValue()}\nEDITED-MARKER-TEXT`);
  await page.waitForTimeout(1000);

  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await expect(page.getByTestId('export-mode-high')).toBeChecked();
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-result')).toContainText('2 / 2', { timeout: 180_000 });
  await page.screenshot({ path: `${SHOTS}/e2e-export-result.png` });

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-download').click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const convertedPdf = fs.readFileSync(downloadPath!);

  // Re-open the exported PDF: it now has a real text layer, so no OCR is needed.
  await clearSession(page);
  await page.goto('/');
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'scanned-2p-text.pdf',
    mimeType: 'application/pdf',
    buffer: convertedPdf,
  });
  await expect(page.getByTestId('notice')).toContainText('已索引', { timeout: 120_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByTestId('ocr-panel')).toHaveCount(0);

  await page.getByTestId('chat-input').fill('文档中相对论的基本假设是什么？');
  await page.getByTestId('chat-send').click();
  const assistantMessages = page.getByTestId('chat-message-assistant');
  await expect(assistantMessages).toHaveCount(1);
  await expect(assistantMessages.first()).toContainText('相对论');
  await expect(page.getByTestId('citation-p2')).toBeVisible();

  const lastRequest = (await (
    await request.get('http://127.0.0.1:9999/last-request')
  ).json()) as { messages?: Array<{ role: string; content: string }> };
  const userMessage = lastRequest.messages?.find((message) => message.role === 'user');
  expect(userMessage?.content).toContain('EDITED-MARKER-TEXT');
  await page.screenshot({ path: `${SHOTS}/e2e-converted-pdf-qa.png` });

  // high mode must skip pages below a strict threshold ...
  await clearSession(page);
  await page.goto('/');
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'scanned-2p.pdf',
    mimeType: 'application/pdf',
    buffer: scannedPdf,
  });
  await waitForOcrText(page, 50);
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-mode-high')).toBeChecked();
  const threshold = page.getByTestId('export-threshold');
  await threshold.focus();
  await threshold.press('End');
  await expect(threshold).toHaveValue('99');
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-result')).toContainText('0 / 2', { timeout: 180_000 });
  await expect(page.getByTestId('export-result')).toContainText('跳过 2 页');
  await page.screenshot({ path: `${SHOTS}/e2e-export-high-skip.png` });
  await page.getByTestId('export-close').click();

  // ... while "all" force-converts every recognized page.
  await clearSession(page);
  await page.goto('/');
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'scanned-2p.pdf',
    mimeType: 'application/pdf',
    buffer: scannedPdf,
  });
  await waitForOcrText(page, 50);
  await page.getByTestId('export-button').click();
  await page.getByTestId('export-mode-all').check();
  await expect(page.getByTestId('export-mode-all')).toBeChecked();
  await page.getByTestId('export-start').click();
  await expect(page.getByTestId('export-result')).toContainText('2 / 2', { timeout: 180_000 });
  await page.screenshot({ path: `${SHOTS}/e2e-export-all-mode.png` });
  await page.getByTestId('export-close').click();
});

test('answers from a text-layer PDF with [p.N] citations and a not-found fallback', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const pdfBuffer = await makeTextPdf(page);

  await clearSession(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'relativity-text.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuffer,
  });

  await expect(page.getByTestId('notice')).toContainText('已索引', { timeout: 120_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 120_000 });
  await page.screenshot({ path: `${SHOTS}/e2e-text-pdf-indexed.png` });

  await page.getByTestId('chat-input').fill('文档中相对论的基本假设是什么？');
  await page.getByTestId('chat-send').click();
  const assistantMessages = page.getByTestId('chat-message-assistant');
  await expect(assistantMessages).toHaveCount(1);
  await expect(assistantMessages.first()).toContainText('相对论');
  await expect(page.getByTestId('citation-p2')).toBeVisible();

  const lastRequest = (await (
    await request.get('http://127.0.0.1:9999/last-request')
  ).json()) as { messages?: Array<{ role: string; content: string }> };
  const systemMessage = lastRequest.messages?.find((message) => message.role === 'system');
  const userMessage = lastRequest.messages?.find((message) => message.role === 'user');
  expect(systemMessage?.content).toContain('你是测试助手，只依据文档回答。');
  expect(userMessage?.content).toContain('光速不变原理');
  expect(userMessage?.content).toMatch(/<pages? \d/);

  await page.getByTestId('citation-p2').click();
  await expect(page.getByTestId('page-input')).toHaveValue('2');
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '2');
  await page.screenshot({ path: `${SHOTS}/e2e-answer-citation.png` });

  await page.getByTestId('chat-input').fill('文档是否提到量子引力？');
  await page.getByTestId('chat-send').click();
  await expect(assistantMessages).toHaveCount(2);
  await expect(assistantMessages.nth(1)).toContainText('未在文档中找到相关内容');
  await expect(assistantMessages.nth(1)).toContainText('未找到依据');
  await page.screenshot({ path: `${SHOTS}/e2e-answer-not-found.png` });
});

test('restores the last PDF, archives the chat and resizes/collapses the sidebar', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const pdfBuffer = await makeTextPdf(page);

  await clearSession(page);
  await page.goto('/');
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'relativity-text.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuffer,
  });
  await expect(page.getByTestId('notice')).toContainText('已索引', { timeout: 120_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 60_000 });

  await page.getByTestId('chat-input').fill('文档中相对论的基本假设是什么？');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('chat-archive-status')).toContainText('已存档', {
    timeout: 20_000,
  });

  // Move to page 2 and switch to an explicit 125% zoom; both should survive reload.
  await page.getByTestId('page-input').fill('2');
  await page.getByTestId('page-input').press('Enter');
  await page.getByTestId('zoom-select').selectOption('125');
  await expect(page.getByTestId('pdf-scroll')).toHaveAttribute('data-rendered-page', '2');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/e2e-restore-before.png` });

  const sessionBefore = (await (
    await page.request.get('http://127.0.0.1:8787/api/session')
  ).json()) as { docId: string; page: number; zoom: number; fitWidth: boolean };
  expect(sessionBefore.page).toBe(2);
  expect(sessionBefore.zoom).toBeCloseTo(1.25, 2);
  expect(sessionBefore.fitWidth).toBe(false);

  const chatsBeforeReload = (await (
    await page.request.get(`http://127.0.0.1:8787/api/documents/${sessionBefore.docId}/chats`)
  ).json()) as { chats: Array<{ id: string }> };
  expect(chatsBeforeReload.chats).toHaveLength(1);
  const archivedChatId = chatsBeforeReload.chats[0].id;

  await page.reload();
  await expect(page.locator('header')).toContainText('relativity-text.pdf');
  await expect(page.getByTestId('page-input')).toHaveValue('2');
  await expect(page.getByTestId('zoom-select')).toHaveValue('125');
  await expect(page.getByTestId('notice')).toContainText('已开启新对话');
  // A reload starts a new conversation; the previous one is archived.
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0, { timeout: 120_000 });

  await page.getByTestId('chat-history-toggle').click();
  await expect(page.getByTestId('chat-history-panel')).toBeVisible();
  await page.getByTestId(`chat-history-item-${archivedChatId}`).click();
  await expect(page.getByTestId('chat-history-banner')).toBeVisible();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1);
  await expect(page.getByTestId('chat-message-user')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/e2e-restore-after.png` });
  await page.getByTestId('chat-history-exit').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0);

  // Drag the sidebar edge to widen it; the PDF stage must re-fit and the sidebar must persist.
  const resizer = page.getByTestId('sidebar-resizer');
  const box = await resizer.boundingBox();
  expect(box).toBeTruthy();
  const widthBefore = await page
    .getByTestId('chat-sidebar')
    .evaluate((element) => element.getBoundingClientRect().width);
  await page.mouse.move(box!.x + 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x - 160, box!.y + box!.height / 2, { steps: 6 });
  await page.mouse.up();
  const widthAfter = await page
    .getByTestId('chat-sidebar')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(widthAfter).toBeGreaterThan(widthBefore + 100);
  await expect(page.getByTestId('pdf-canvas')).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/e2e-sidebar-resized.png` });

  // The top-of-sidebar button closes it and the toolbar button reopens it.
  await page.getByTestId('sidebar-close').click();
  await expect(page.getByTestId('chat-sidebar')).toHaveCount(0);
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('chat-sidebar')).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('chat-sidebar')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('notice')).toContainText('已开启新对话', { timeout: 120_000 });
  await expect(page.getByTestId('chat-history-toggle')).toContainText('1', { timeout: 60_000 });
  const widthAfterReload = await page
    .getByTestId('chat-sidebar')
    .evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.abs(widthAfterReload - widthAfter)).toBeLessThan(4);

  // Delete the archived history entry: the menu and local storage must both clear.
  await page.getByTestId('chat-history-toggle').click();
  await expect(page.getByTestId('chat-history-panel')).toBeVisible();
  await expect(page.getByTestId(`chat-history-item-${archivedChatId}`)).toBeVisible();
  await page.getByTestId(`chat-history-delete-${archivedChatId}`).click();
  await expect(page.getByTestId(`chat-history-item-${archivedChatId}`)).toHaveCount(0);
  const chatsAfterDelete = (await (
    await page.request.get(`http://127.0.0.1:8787/api/documents/${sessionBefore.docId}/chats`)
  ).json()) as { chats: unknown[] };
  expect(chatsAfterDelete.chats).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/e2e-chat-cleared.png` });
});

test('answers page-focused questions with the requested page in context', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  const pdfBuffer = await makeLongTextPdf(page);

  await clearSession(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'page-intent.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuffer,
  });
  await expect(page.getByTestId('notice')).toContainText('已索引', { timeout: 120_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 120_000 });

  const footers = page.getByTestId('context-footer');

  // 1) Single page: page intent must beat the summary classifier.
  await page.getByTestId('chat-input').fill('第2页讲了什么？');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1);
  await expect(footers.first()).toContainText('指定页');
  await expect(footers.first()).toContainText('目标页 2');
  const singleRequest = (await (
    await request.get('http://127.0.0.1:9999/last-request')
  ).json()) as { messages?: Array<{ role: string; content: string }> };
  const singleUser = singleRequest.messages?.find((message) => message.role === 'user');
  expect(singleUser?.content).toContain('两条基本假设');
  expect(singleUser?.content).toContain('相对论讲义');
  await page.screenshot({ path: `${SHOTS}/e2e-page-intent-single.png` });

  // 2) Page range: both target pages must be reported in the footer.
  await page.getByTestId('chat-input').fill('第1到2页分别讲了什么？');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(2);
  await expect(footers.nth(1)).toContainText('指定页');
  await expect(footers.nth(1)).toContainText('目标页 1, 2');
  const rangeRequest = (await (
    await request.get('http://127.0.0.1:9999/last-request')
  ).json()) as { messages?: Array<{ role: string; content: string }> };
  const rangeUser = rangeRequest.messages
    ?.filter((message) => message.role === 'user')
    .at(-1);
  expect(rangeUser?.content).toContain('两条基本假设');
  expect(rangeUser?.content).toContain('质能等价');
  await page.screenshot({ path: `${SHOTS}/e2e-page-intent-range.png` });

  // 3) Broad summary question keeps the existing summary strategy.
  await page.getByTestId('chat-input').fill('这份文档讲了什么？');
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(3);
  await expect(footers.nth(2)).toContainText('分层抽样');
  await page.screenshot({ path: `${SHOTS}/e2e-page-intent-summary.png` });
});

test('enhances the draft prompt without sending and keeps input on failure', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const pdfBuffer = await makeTextPdf(page);

  await clearSession(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await page.getByTestId('pdf-file-input').setInputFiles({
    name: 'enhance-prompt.pdf',
    mimeType: 'application/pdf',
    buffer: pdfBuffer,
  });
  await expect(page.getByTestId('notice')).toContainText('已索引', { timeout: 120_000 });
  await expect(page.getByTestId('chat-input')).toBeEnabled({ timeout: 120_000 });

  const input = page.getByTestId('chat-input');
  const enhanceButton = page.getByTestId('enhance-prompt');
  const enhanceStatus = page.getByTestId('enhance-status');

  // 1) Empty input gets an explicit hint and never sends a request.
  await enhanceButton.click();
  await expect(enhanceStatus).toContainText('请先在输入框写下问题');
  await expect(input).toHaveValue('');
  await page.screenshot({ path: `${SHOTS}/e2e-enhance-empty.png` });

  // 2) Successful rewrite fills the textarea and does not auto-send.
  await input.fill('相对论假设');
  await enhanceButton.click();
  await expect(enhanceStatus).toContainText('正在用当前模型增强提示词');
  await expect(enhanceButton).toBeDisabled();
  await expect(enhanceStatus).toContainText('已增强并回填', { timeout: 15_000 });
  await expect(input).toHaveValue('请具体说明相对论的两条基本假设，并分别引用文档页码。');
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/e2e-enhance-success.png` });

  // Sending is still an explicit user action.
  await page.getByTestId('chat-send').click();
  await expect(page.getByTestId('chat-message-assistant')).toHaveCount(1);

  // 3) A failed rewrite keeps the user's original draft untouched.
  await input.fill('触发失败的问题');
  await enhanceButton.click();
  await expect(enhanceStatus).toContainText('增强失败', { timeout: 15_000 });
  await expect(input).toHaveValue('触发失败的问题');
  await page.screenshot({ path: `${SHOTS}/e2e-enhance-failure.png` });
});
