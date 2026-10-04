import { test, expect } from '@playwright/test';

test('explorer renders real catalog, validates requests, and never calls Agora offline', async ({ page }) => {
  const external = [];
  const errors = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4318')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#mode')).toHaveText('OFFLINE MODE');
  await expect(page.locator('#products-count')).toHaveText('17');
  await expect(page.locator('#live-run')).toBeDisabled();
  await expect(page.locator('#live-count')).toHaveText('0');
  const options = await page.locator('#operation option').evaluateAll(items => items.map(i => ({ value: i.value, text: i.textContent })));
  const query = options.find(o => /GET.*channel list/i.test(o.text));
  await page.locator('#operation').selectOption(query.value);
  await page.locator('#request').fill(JSON.stringify({ path: { appid: 'a'.repeat(32) }, query: {} }));
  await page.locator('#dry-run').click();
  await expect(page.locator('#result-status')).toHaveText('LOCAL VALIDATION ONLY');
  await expect(page.locator('#result')).toContainText('"networkCalled": false');
  await page.locator('#request').fill('{');
  await page.locator('#dry-run').click();
  await expect(page.locator('#result-status')).toHaveText('INPUT / REQUEST ERROR');
  await page.locator('#search').fill('IoT');
  await page.locator('.product-button').click();
  await expect(page.locator('#result-status')).toHaveText('SPECIALIZED SETUP');
  await expect(page.locator('#dry-run')).toBeDisabled();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test('local camera preview works with fake browser media and token tools report missing setup', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#mode')).toHaveText('OFFLINE MODE');
  await expect(page.locator('#products-count')).toHaveText('17');
  await page.getByRole('button', { name: 'Voice / video test', exact: true }).click();
  await page.locator('#media-mode').selectOption('video');
  await page.locator('#device-preview').click();
  await expect(page.locator('#rtc-status')).toContainText('Local preview only', { timeout: 10_000 });
  expect(await page.locator('#preview').evaluate(video => video.srcObject.getTracks().every(t => t.readyState === 'live'))).toBe(true);
  await page.locator('#device-stop').click();
  expect(await page.locator('#preview').evaluate(video => video.srcObject)).toBeNull();
  await page.locator('#rtc-join').click();
  await expect(page.locator('#rtc-status')).toContainText('Live mode');
  await page.getByRole('button', { name: 'Token tools', exact: true }).click();
  await page.locator('#generate-token').click();
  await expect(page.locator('#token-result')).toContainText('I-enable muna ang live mode');
});

test('mobile layout and event runbook remain readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#mode')).toHaveText('OFFLINE MODE');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Event checklist', exact: true }).click();
  await expect(page.locator('#readiness')).toContainText('"liveVerified": false');
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
});

test('desktop preview artifact', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await expect(page.locator('#products-count')).toHaveText('17');
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
});
