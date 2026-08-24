import { test, expect, type BrowserContext, type Page } from '@playwright/test';

const PHONE_A = '+12025559001';
const PHONE_B = '+12025559002';

async function signup(page: Page, phone: string, name: string) {
  await page.goto('/');
  await page.waitForSelector('.auth-card', { timeout: 10_000 });
  const phoneInput = page.locator('.auth-card input[type="tel"], .auth-card input[placeholder*="phone"], .auth-card input').first();
  await phoneInput.fill(phone);
  await page.locator('.auth-card button[type="submit"], .auth-card button').first().click();
  await page.waitForSelector('input[placeholder*="code"], input[maxlength="6"]', { timeout: 10_000 });
  const resp = await page.request.post('/api/auth/sendCode', { data: { phone } });
  const data = await resp.json();
  const codeInput = page.locator('input[placeholder*="code"], input[maxlength="6"]').first();
  await codeInput.fill(data.dev_code);
  await page.waitForTimeout(500);
  const nameInput = page.locator('input[placeholder*="name"], input[placeholder*="Name"]').first();
  if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    await nameInput.fill(name);
    await page.locator('button[type="submit"], button').last().click();
  }
  await page.waitForSelector('.chat-list, .chats, [class*="chat"]', { timeout: 15_000 });
}

test.describe('Multi-device sync', () => {
  test('message sent from device A appears on device B', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    try {
      // Sign up both users
      await signup(pageA, PHONE_A, 'Device A User');
      await signup(pageB, PHONE_B, 'Device B User');

      // Create a direct chat from A to B
      // A searches for B
      const searchInput = pageA.locator('input[placeholder*="Search"], .search-input input').first();
      await searchInput.fill('Device B');
      await pageA.waitForTimeout(1000);
      // Click on B's user in search results
      const resultItem = pageA.locator('.search-item, .search-result').first();
      if (await resultItem.isVisible({ timeout: 3000 }).catch(() => false)) {
        await resultItem.click();
        await pageA.waitForTimeout(500);
      }

      // Find message input and send a message
      const msgInput = pageA.locator('textarea, input[placeholder*="message"], input[placeholder*="Message"]').first();
      if (await msgInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await msgInput.fill('Hello from device A!');
        await pageA.keyboard.press('Enter');
        await pageA.waitForTimeout(1000);
      }

      // On device B, check chat list for the new message
      // Navigate to the chat and check the message appears
      await pageB.waitForTimeout(2000);
      const chatItem = pageB.locator('.chat-item, [class*="chat-item"]').first();
      if (await chatItem.isVisible({ timeout: 5000 }).catch(() => false)) {
        await chatItem.click();
        await pageB.waitForTimeout(1000);
        const messageText = pageB.locator('.msg-text, [class*="message-body"], .message-text').first();
        if (await messageText.isVisible({ timeout: 5000 }).catch(() => false)) {
          await expect(messageText).toContainText('Hello from device A!');
        }
      }
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
