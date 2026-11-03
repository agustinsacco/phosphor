import { test, expect } from './fixture'

// The keyboard flow of a lane WITH a PR is covered by Desktop e2e and LanePrHeader.test.
test('a Host lane without a PR shows no PR control in phone and wide headers', async ({
  stack,
  page,
}) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  for (const width of [400, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
    await expect(page.getByTestId('transcript-scroll')).toBeVisible()
    await expect(page.locator('header').getByTestId('lane-pr-status')).toHaveCount(0)
    expect(
      await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth),
    ).toBe(true)
  }
})
