import { test, expect } from '@playwright/test';

const coachUrl = 'http://127.0.0.1:4316';

test('product shell is responsive, self-contained, and honest about its evidence boundary', async ({ page }) => {
  const external = [];
  await page.route('**/api/auth/session', route => route.fulfill({ status: 401, json: { code: 'unauthorized', message: 'authentication required' } }));
  page.on('request', request => {
    if (!request.url().startsWith(coachUrl)) external.push(request.url());
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(coachUrl);
  await expect(page.getByRole('heading', { name: /Practice your voice/i })).toBeVisible();
  await expect(page.getByText(/review signal/i)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(external).toEqual([]);
});

test('learner account sees only the learner workspace and backend-managed progress', async ({ page }) => {
  await page.route('**/api/auth/session', route => route.fulfill({ json: { email: 'learner@example.test', role: 'learner' } }));
  await page.goto(coachUrl);
  await expect(page.getByRole('heading', { name: /One passage/i })).toBeVisible();
  await expect(page.locator('#learner')).toBeVisible();
  await expect(page.locator('#annotator')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review' })).toBeHidden();
  await expect(page.getByText(/temporary full-session audio/i)).toBeVisible();
});

test('annotator can submit every backend decision field from private sentence evidence', async ({ page }) => {
  let submitted;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/auth/session') {
      await route.fulfill({ json: { email: 'reviewer@example.test', role: 'annotator' } });
      return;
    }
    if (url.pathname === '/api/annotation/queue') {
      await route.fulfill({ json: [{
        id: 'item-1', session_id: 'session-1', expected_text: 'Fifty people think clearly.',
        agora_text: 'Fifty people think clearly.', buzz_text: 'Fifty people sink clearly.',
        sentence_start_ms: 0, sentence_end_ms: 3200, focus_start_ms: 1200, focus_end_ms: 1900,
        clip_key: 'private.wav', status: 'pending',
      }] });
      return;
    }
    if (url.pathname.endsWith('/decision')) {
      submitted = JSON.parse(route.request().postData());
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({ status: 200, body: '' });
  });

  await page.goto(coachUrl);
  await expect(page.getByRole('heading', { name: /Fifty people think clearly/i })).toBeVisible();
  await expect(page.locator('#learner')).toBeHidden();
  await expect(page.locator('#annotator .review-body > *')).toHaveCount(3);
  await page.getByLabel('Review decision').selectOption('corrected_transcript');
  await page.getByLabel('Corrected transcript').fill('Fifty people think clearly.');
  await page.getByLabel(/Reviewer notes/).fill('Reviewed with the full sentence context.');
  await page.getByRole('button', { name: 'Save decision' }).click();
  expect(submitted).toEqual({
    decision: 'corrected_transcript',
    corrected_text: 'Fifty people think clearly.',
    notes: 'Reviewed with the full sentence context.',
  });
});

test('annotator clip stops when leaving review, refreshing, and removing a reviewed card', async ({ page }) => {
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/session') return route.fulfill({ json: { email: 'reviewer@example.test', role: 'annotator' } });
    if (path === '/api/annotation/queue') return route.fulfill({ json: [{
      id: 'item-1', expected_text: 'A sentence to review.', agora_text: 'A sentence to review.',
      buzz_text: 'A sentence to review.', sentence_start_ms: 0, sentence_end_ms: 2000,
      focus_start_ms: 0, focus_end_ms: 1000,
    }] });
    if (path.endsWith('/decision')) return route.fulfill({ status: 204 });
    return route.fulfill({ status: 200, body: '' });
  });
  await page.goto(coachUrl);
  const audio = page.locator('#annotator audio');
  await expect(audio).toBeVisible();
  await page.evaluate(() => {
    window.annotationPauses = 0;
    HTMLMediaElement.prototype.pause = function () { window.annotationPauses += 1; };
  });

  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.locator('#annotator')).toBeHidden();
  expect(await page.evaluate(() => window.annotationPauses)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(audio).toBeVisible();
  const beforeRefresh = await page.evaluate(() => window.annotationPauses);
  await page.getByRole('button', { name: 'Refresh queue' }).click();
  await expect.poll(() => page.evaluate(() => window.annotationPauses)).toBeGreaterThan(beforeRefresh);

  const beforeDecision = await page.evaluate(() => window.annotationPauses);
  await page.getByRole('button', { name: 'Save decision' }).click();
  await expect(page.locator('#annotator audio')).toHaveCount(0);
  expect(await page.evaluate(() => window.annotationPauses)).toBeGreaterThan(beforeDecision);
});
