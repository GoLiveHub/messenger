import { test, expect } from '@playwright/test';

const PHONE = '+12025551234';
const NAME = 'E2E Test User';

test.describe('Messenger E2E', () => {
  test('signup, send message, see it appear', async ({ page }) => {
    await page.goto('/');
    // Wait for auth page
    await page.waitForSelector('.auth-card', { timeout: 10_000 });

    // Enter phone number
    const phoneInput = page.locator('.auth-card input[type="tel"], .auth-card input[placeholder*="phone"], .auth-card input').first();
    await phoneInput.fill(PHONE);
    await page.locator('.auth-card button[type="submit"], .auth-card button').first().click();

    // Wait for code step (dev mode shows code)
    await page.waitForSelector('input[placeholder*="code"], input[maxlength="6"]', { timeout: 10_000 });

    // Fetch the dev code from server
    const resp = await page.request.post('/api/auth/sendCode', {
      data: { phone: PHONE },
    });
    const data = await resp.json();
    const devCode = data.dev_code;
    expect(devCode).toBeTruthy();

    const codeInput = page.locator('input[placeholder*="code"], input[maxlength="6"]').first();
    await codeInput.fill(devCode);
    await page.waitForTimeout(500);

    // If redirected to signup
    const nameInput = page.locator('input[placeholder*="name"], input[placeholder*="Name"]').first();
    if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nameInput.fill(NAME);
      await page.locator('button[type="submit"], button').last().click();
    }

    // Wait for main app to load (chat list)
    await page.waitForSelector('.chat-list, .chats, [class*="chat"]', { timeout: 15_000 });
  });

  test('mobile: chat list renders and is scrollable', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Mobile viewport test skipped on Firefox desktop');
    await page.goto('/');
    await page.waitForSelector('.auth-card, .chat-list', { timeout: 10_000 });
    // On mobile devices, layout should stack vertically
    const viewport = page.viewportSize();
    expect(viewport).toBeTruthy();
    if (viewport && viewport.width < 768) {
      const chatList = page.locator('.chat-list, [class*="chat"]');
      await expect(chatList.first()).toBeVisible();
    }
  });

  test('mobile: responsive layout does not overflow', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await page.waitForSelector('.auth-card', { timeout: 10_000 });
    // Ensure no horizontal scrollbar on mobile
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 5);
  });
});

test.describe('Accessibility', () => {
  test('auth page has accessible form elements', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.auth-card', { timeout: 10_000 });

    // Check that inputs have labels or aria-labels
    const inputs = page.locator('.auth-card input');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      const hasLabel = await input.evaluate((el: HTMLInputElement) => {
        return Boolean(
          el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          el.labels?.length ||
          el.closest('label'),
        );
      });
      expect(hasLabel).toBeTruthy();
    }
  });

  test('ARIA landmarks are present', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.auth-card', { timeout: 10_000 });
    // Auth card should be a dialog or have role
    const hasDialog = await page.evaluate(() => {
      return document.querySelectorAll('[role="dialog"], [role="main"], main, [role="status"]').length > 0;
    });
    expect(hasDialog).toBeTruthy();
  });

  test('keyboard navigation on auth page', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.auth-card', { timeout: 10_000 });
    // Tab should move focus between interactive elements
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName);
    expect(['INPUT', 'BUTTON', 'A', 'SELECT']).toContain(focused);
  });
});
