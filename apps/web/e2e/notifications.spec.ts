import { test, expect } from './fixture'

for (const width of [400, 1100]) {
  test(`notification bell and ${width < 900 ? 'sheet' : 'drawer'} keep Host receipts at ${width}px`, async ({
    stack,
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(stack.origin)
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await expect(page.getByTestId('home-board')).toBeVisible()
    const bell = page.getByTestId('notifications-button')
    await expect(bell).toBeVisible()
    await expect.poll(async () => (await bell.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    await bell.click()
    const drawer = page.getByTestId('notification-drawer')
    await expect(drawer).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Notifications', exact: true })).toHaveCount(
      width < 900 ? 1 : 0,
    )
    const box = await drawer.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1)
    if (width < 900) {
      expect(box!.width).toBe(width)
      expect(box!.height).toBeGreaterThan(800)
      await expect(
        page.getByRole('navigation', { name: 'Tabs', exact: true }).getByRole('button'),
      ).toHaveCount(4)
    }
    // A real Host turn while Home is on screen feeds the same notice pipeline as Desktop.
    await page.evaluate(
      async ({ hostId, laneId }) => {
        const lane = await window.phosphor.invoke('hosts:openLane', hostId, laneId)
        await window.phosphor.invoke('hosts:takeControl', hostId, laneId)
        const result = await window.phosphor.piCommand(lane.sessionId, {
          type: 'prompt',
          message: 'notification acceptance',
        })
        if (!result.success) throw new Error('Synthetic prompt refused')
      },
      { hostId: stack.hostId, laneId: stack.laneId },
    )
    const row = drawer.getByTestId('notification-row').filter({ hasText: 'Synthetic Host' })
    await expect(row).toHaveCount(1)
    await expect(bell).toHaveAttribute('aria-label', 'Notifications, 1 new')
    await row.locator('button[aria-expanded]').click()
    await expect(row.getByRole('button', { name: 'Open lane', exact: true })).toBeVisible()
    await expect(row).not.toHaveAttribute('data-seen')
    await page.screenshot({ path: info.outputPath(`notifications-${width}.png`) })
    await row.getByRole('button', { name: 'Open lane', exact: true }).click()
    await expect(drawer).toHaveCount(0)
    await expect(page).toHaveURL(new RegExp(`/lanes/${stack.hostId}/${stack.laneId}/chat$`))
    await expect(page.getByTestId('transcript-scroll')).toBeVisible()
  })
}

test('granted browser permission sends a worker test notification without prompting on load', async ({
  stack,
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'WebKit does not expose notification permissions in Playwright',
  )
  await context.grantPermissions(['notifications'], { origin: stack.origin })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  await page
    .getByRole('navigation', { name: 'Tabs', exact: true })
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  await page
    .getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name: 'Notifications', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: 'Turn on notifications', exact: true }),
  ).toBeDisabled()
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await page.getByRole('button', { name: 'Send a test notification', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('Test notification sent.')
  const tags = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    const notices = await registration.getNotifications()
    const tags = notices.map((notice) => notice.tag)
    notices.forEach((notice) => notice.close())
    return tags
  })
  expect(tags).toContain('phosphor:test')
  expect(
    await page.evaluate(() =>
      window.phosphor.invoke('app:notify', { title: 'Visible', body: 'Do not deliver' }),
    ),
  ).toBe(false)
})
