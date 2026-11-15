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
      async ({ hostId, laneIds }) => {
        for (const laneId of laneIds) {
          const lane = await window.phosphor.invoke('hosts:openLane', hostId, laneId)
          await window.phosphor.invoke('hosts:takeControl', hostId, laneId)
          const result = await window.phosphor.piCommand(lane.sessionId, {
            type: 'prompt',
            message: 'notification acceptance',
          })
          if (!result.success) throw new Error('Synthetic prompt refused')
        }
      },
      { hostId: stack.hostId, laneIds: [stack.laneId, stack.secondLaneId] },
    )
    const rows = drawer.getByTestId('notification-row').filter({ hasText: 'Synthetic Host' })
    await expect(rows).toHaveCount(2)
    const row = rows.filter({ hasText: 'Synthetic acceptance lane' })
    await expect(row).toHaveCount(1)
    await expect(bell).toHaveAttribute('aria-label', 'Notifications, 2 new')
    await row.locator('button[aria-expanded]').click()
    await expect(row.getByRole('button', { name: 'Open lane', exact: true })).toBeVisible()
    await expect(row).not.toHaveAttribute('data-seen')
    await page.screenshot({ path: info.outputPath(`notifications-${width}.png`) })
    await row.getByRole('button', { name: 'Open lane', exact: true }).click()
    await expect(drawer).toHaveCount(width < 900 ? 0 : 1)
    await expect(page).toHaveURL(new RegExp(`/lanes/${stack.hostId}/${stack.laneId}/chat$`))
    await expect(page.getByTestId('transcript-scroll')).toBeVisible()
    if (width < 900) {
      await page.getByRole('button', { name: 'Back to lanes', exact: true }).click()
      await expect(bell).toHaveAttribute('aria-label', 'Notifications, 1 new')
      await bell.click()
    } else await expect(bell).toHaveAttribute('aria-label', 'Notifications, 1 new')
    await expect(drawer.locator('[data-testid="notification-row"]:not([data-seen])')).toHaveCount(1)
  })
}

for (const width of [400, 1100]) {
  test(`notification permission controls reflect this browser without prompting at ${width}px`, async ({
    stack,
    page,
    context,
    browserName,
  }) => {
    test.skip(
      browserName !== 'chromium',
      'WebKit does not expose notification permissions in Playwright',
    )
    await page.setViewportSize({ width, height: 850 })
    await context.grantPermissions(['notifications'])
    await page.addInitScript(() => {
      const request = Notification.requestPermission.bind(Notification)
      Notification.requestPermission = (...args) => {
        sessionStorage.setItem('notificationPermissionRequested', 'true')
        return request(...args)
      }
    })
    await page.goto(stack.origin)
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await expect(page.getByTestId('home-board')).toBeVisible()
    const navigation =
      width < 900
        ? page.getByRole('navigation', { name: 'Tabs', exact: true })
        : page.locator('aside.browser-navigation')
    await navigation.getByRole('button', { name: 'Settings', exact: true }).click()
    await page
      .getByRole('navigation', { name: 'Settings sections', exact: true })
      .getByRole('button', { name: 'Notifications', exact: true })
      .click()
    // Some headless Chromium builds report denied despite grantPermissions. Pin
    // the real API state, not the automation grant; worker delivery is unit-tested.
    const permission = await page.evaluate(() => Notification.permission)
    const turnOn = page.getByRole('button', { name: 'Turn on notifications', exact: true })
    const sendTest = page.getByRole('button', { name: 'Send a test notification', exact: true })
    if (permission === 'default') await expect(turnOn).toBeEnabled()
    else await expect(turnOn).toBeDisabled()
    if (permission === 'granted') await expect(sendTest).toBeEnabled()
    else await expect(sendTest).toBeDisabled()
    if (permission === 'denied')
      await expect(
        page.getByText('Allow notifications in your browser’s site settings, then return here.'),
      ).toBeVisible()
    expect(
      await page.evaluate(() => sessionStorage.getItem('notificationPermissionRequested')),
    ).toBeNull()
    expect(
      await page.evaluate(() =>
        window.phosphor.invoke('app:notify', { title: 'Visible', body: 'Do not deliver' }),
      ),
    ).toBe(false)
  })
}
