import { test, expect, type Page } from '@playwright/test'

/** Keep the whole read interval, not just whichever toast is visible at the final assertion. */
export async function watchBrainErrors(page: Page): Promise<() => Promise<void>> {
  const errors = await page.evaluateHandle(() => {
    const seen: string[] = []
    const collect = (): void => {
      for (const toast of document.querySelectorAll('[data-testid="toast"][data-kind="error"]')) {
        const text = toast.textContent ?? ''
        if (!seen.includes(text)) seen.push(text)
      }
    }
    new MutationObserver(collect).observe(document.body, { subtree: true, childList: true })
    collect()
    return seen
  })
  return async () => expect(await errors.jsonValue()).toEqual([])
}

export async function expectBoundedReadText(page: Page): Promise<void> {
  const detail = page.getByRole('region', { name: 'Extraction detail', exact: true })
  await detail.getByText('Read the conversation · part 1', { exact: false }).click()
  await detail.getByText('Source lane at extraction', { exact: true }).click()
  await expect(detail.locator('pre')).toHaveCount(3)
  for (const pre of await detail.locator('pre').all()) {
    const size = await pre.evaluate((element) => {
      let scroll = element.parentElement
      while (
        scroll &&
        !(
          getComputedStyle(scroll).overflowY === 'auto' &&
          getComputedStyle(scroll).maxHeight !== 'none'
        )
      )
        scroll = scroll.parentElement
      return (
        scroll && {
          height: scroll.getBoundingClientRect().height,
          client: scroll.clientHeight,
          scroll: scroll.scrollHeight,
        }
      )
    })
    expect(size, 'text has a capped scroll ancestor').not.toBeNull()
    expect(size!.height).toBeLessThanOrEqual(385)
    expect(size!.scroll).toBeGreaterThan(size!.client)
  }
}

export async function expectReviewBarAtBottom(page: Page): Promise<void> {
  const review = page.getByRole('article', { name: 'Review memories', exact: true })
  const bar = review.getByRole('group', { name: 'Decision actions', exact: true })
  await expect(bar.getByRole('button', { name: 'Reject read', exact: true })).toBeVisible()
  const gap = await bar.evaluate((element) => {
    const pane = element.closest('.brain-pane')!
    return pane.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
  })
  expect(gap, 'a short review keeps its actions at the bottom of the pane').toBeLessThanOrEqual(1)
}

export async function attachBrainFailure(page: Page): Promise<void> {
  const snapshot = await page.evaluate(() => window.phosphor.invoke('brain:status'))
  const records = await page.evaluate(
    async (ids) =>
      Promise.all(ids.map((id) => window.phosphor.invoke('brain:extraction', id).catch(String))),
    snapshot.jobs.map((job) => job.id),
  )
  await test.info().attach('brain-failure.json', {
    body: JSON.stringify({ snapshot, records }, null, 2),
    contentType: 'application/json',
  })
}

export async function expectGraphFocusClear(page: Page): Promise<void> {
  const badge = page.getByRole('status').filter({ hasText: 'Focus Rina Okafor' })
  await expect(badge).toBeVisible()
  const focus = (await badge.boundingBox())!
  for (const surface of [
    page.locator('[aria-label="Entity kinds"]'),
    page.getByRole('button', { name: 'Clear selection', exact: true }).locator('..'),
  ]) {
    const box = (await surface.boundingBox())!
    const overlaps =
      focus.x < box.x + box.width &&
      focus.x + focus.width > box.x &&
      focus.y < box.y + box.height &&
      focus.y + focus.height > box.y
    expect(overlaps, 'keyboard focus badge does not cover legend or selection').toBe(false)
  }
}

/** Each proposed memory's tick box sits on the first line of its sentence. */
export async function expectReviewRowAligned(page: Page): Promise<void> {
  const row = page
    .getByRole('region', { name: 'Proposed memories', exact: true })
    .getByRole('checkbox', { name: /^Keep: / })
    .first()
  const sentence = page
    .getByRole('region', { name: 'Proposed memories', exact: true })
    .locator('label[for]')
    .first()
  const box = (await row.boundingBox())!
  const text = (await sentence.boundingBox())!
  const line = await sentence.evaluate((element) =>
    parseFloat(getComputedStyle(element).lineHeight),
  )
  const middle = box.y + box.height / 2
  expect(middle, 'tick box is level with the sentence').toBeGreaterThanOrEqual(text.y)
  expect(middle, 'tick box is on the first line').toBeLessThanOrEqual(text.y + line)
}
