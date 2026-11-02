import { test, expect } from './fixture'

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
