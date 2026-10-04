import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

const template = readFileSync(new URL('../../docs/pitch/gabaybigkas-semi-finals.html', import.meta.url), 'utf8')

test('self-contained pitch deck navigates all slides and renders benchmark evidence safely', async ({ page }) => {
  const errors = []
  const requests = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => requests.push(request.url()))
  await page.setContent(template.replace('<!-- BENCHMARK_SLIDE_DATA -->', '<script>window.GABAYBIGKAS_SLIDE_DATA={suite:"Passed 2026-10-04",loadStatus:"Stopped early",rps:"12.3",p95:"42 ms",p99:"55 ms",runNote:"<img src=x onerror=alert(1)>"}</script>'))
  await expect(page.locator('.slide')).toHaveCount(15)
  await page.keyboard.press('End')
  await expect(page.locator('.slide.active')).toHaveAttribute('aria-label', 'Slide 15 of 15')
  await expect(page.locator('[data-slide-field="rps"]')).toHaveText('12.3')
  await expect(page.locator('[data-slide-field="p99"]')).toHaveText('55 ms')
  await expect(page.locator('[data-slide-field="runNote"]')).toHaveText('<img src=x onerror=alert(1)>')
  await expect(page.locator('[data-slide-field="runNote"] img')).toHaveCount(0)
  await page.keyboard.press('n')
  await expect(page.locator('#notes-panel')).toBeVisible()
  await expect(page.locator('#notes-copy')).toContainText('Spot GPU is not deployed')
  await page.keyboard.press('n')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.slide.active')).toHaveAttribute('aria-label', 'Slide 14 of 15')
  await page.keyboard.press('Home')
  await expect(page.locator('.slide.active')).toHaveAttribute('aria-label', 'Slide 1 of 15')
  expect(errors).toEqual([])
  expect(requests).toEqual([])
})

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`evidence slide stays readable at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.setContent(template)
    await page.keyboard.press('End')
    await expect(page.locator('.slide.active')).toHaveAttribute('aria-label', 'Slide 15 of 15')
    const layout = await page.locator('.slide.active').evaluate((slide) => ({
      width: slide.clientWidth, height: slide.clientHeight,
      scrollWidth: slide.scrollWidth, scrollHeight: slide.scrollHeight,
      overflow: getComputedStyle(slide).overflowY,
    }))
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1)
    if (viewport.width > 840) expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1)
    else expect(layout.overflow).toBe('auto')
  })
}
