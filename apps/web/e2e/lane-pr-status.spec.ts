import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

/** Focus inside a header popup must never scroll the page (overflow: hidden stops users, not focus). */
const pageScroll = (page: Page): Promise<number> =>
  page.evaluate(() => (document.scrollingElement?.scrollTop ?? 0) + document.body.scrollTop)

test('active Host lane has keyboard-accessible PR details in phone and wide headers', async ({
  stack,
  page,
}) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  for (const width of [400, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
    const pill = page.locator('header').getByTestId('lane-pr-status')
    await expect(pill).toBeVisible()
    await pill.focus()
    await pill.press('Enter')
    const details = page.getByRole('region', { name: 'Pull request details' })
    await expect(details).toBeVisible()
    expect(await pageScroll(page)).toBe(0)
    await expect(details).toContainText('Host may reuse its repository cache for up to 60 seconds')
    await expect(details).not.toContainText('No pull request yet')
    await expect(details.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    await details.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(details.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(pill).toBeFocused()
    expect(
      await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth),
    ).toBe(true)
  }
})

test('a Slack thread the Host lane mentions becomes a header quick link', async ({
  stack,
  page,
}) => {
  const thread = 'https://acme.slack.com/archives/C0123ABC/p1730563200123456'
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  const slack = page.locator('header').getByTestId('lane-slack-threads')
  await expect(page.locator('header').getByTestId('lane-pr-status')).toBeVisible()
  await expect(slack).toHaveCount(0)
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await page.locator('textarea').fill(`PHX-slack fix what they asked in ${thread}`)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  for (const width of [400, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    await expect(slack).toHaveAttribute('aria-label', '1 Slack thread in context')
    await slack.focus()
    await slack.press('Enter')
    const list = page.getByRole('region', { name: 'Slack threads in this lane' })
    await expect(list).toContainText('PHX-slack fix what they asked in')
    expect(await pageScroll(page)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(list).toHaveCount(0)
    await expect(slack).toBeFocused()
    expect(await pageScroll(page)).toBe(0)
    expect(
      await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth),
    ).toBe(true)
  }
})
