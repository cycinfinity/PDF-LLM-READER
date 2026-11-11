import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = 'docs/screenshots';
const VERIFY = 'artifacts/verify';
fs.mkdirSync(VERIFY, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];

try {
  await page.goto('http://127.0.0.1:5173');
  await page.waitForFunction(
    () => {
      const input = document.querySelector('[data-testid="chat-input"]');
      return input instanceof HTMLTextAreaElement && !input.disabled;
    },
    { timeout: 180_000 },
  );
  await page.waitForFunction(
    () => document.querySelector('[data-testid="pdf-scroll"]')?.getAttribute('data-rendered-page') !== null,
    { timeout: 120_000 },
  );
  await page.waitForTimeout(1500);

  async function ask(question, name) {
    const before = await page.getByTestId('chat-message-assistant').count();
    await page.getByTestId('chat-input').fill(question);
    await page.getByTestId('chat-send').click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-testid="chat-message-assistant"]').length > count,
      before,
      { timeout: 240_000 },
    );
    await page.waitForFunction(
      () => {
        const input = document.querySelector('[data-testid="chat-input"]');
        return input instanceof HTMLTextAreaElement && !input.disabled;
      },
      { timeout: 120_000 },
    );
    await page.waitForTimeout(600);
    const answer = await page.getByTestId('chat-message-assistant').last().innerText();
    const footer = await page.getByTestId('context-footer').last().innerText();
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
    const record = { name, question, footer: footer.replace(/\s+/g, ' ').trim(), answer: answer.slice(0, 800) };
    results.push(record);
    console.log(`\n### ${name}\nQ: ${question}\nFOOTER: ${record.footer}\nA: ${answer.slice(0, 260)}`);
  }

  await ask('第18页讲了什么？请概括这一页的内容并引用页码。', 'page-intent-alaska-single');
  await ask('第20到21页分别讲了什么？', 'page-intent-alaska-range');
  await ask('这份文档讲了什么？', 'page-intent-alaska-summary');
  fs.writeFileSync(`${VERIFY}/page-intent-acceptance.json`, JSON.stringify({ verifiedAt: new Date().toISOString(), pdf: 'Looking for Alaska (John Green)', results }, null, 2));
  console.log('\nACCEPTANCE_OK');
} finally {
  await browser.close();
}
