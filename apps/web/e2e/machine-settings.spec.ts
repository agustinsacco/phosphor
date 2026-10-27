import { test, expect } from './fixture'

test('browser Host settings keep the Desktop-only configuration boundary explicit', async ({
  page,
  stack,
}, info) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  await page.goto(`${stack.origin}/pages/machines`)
  await page.getByRole('button', { name: /Synthetic Host/ }).click()
  await page
    .getByRole('navigation', { name: 'Machine views' })
    .getByRole('button', { name: 'Machine settings', exact: true })
    .click()
  const settings = page.getByTestId('machine-settings')
  for (const section of ['Providers', 'Connectors', 'Agent defaults', 'Skills & extensions']) {
    await settings
      .getByRole('navigation', { name: 'Machine settings', exact: true })
      .getByRole('button', { name: section, exact: true })
      .click()
    await expect(settings).toContainText('Machine configuration is available in Phosphor Desktop')
    await expect(
      settings.getByRole('button', { name: 'Enable configuration access', exact: true }),
    ).toHaveCount(0)
    await expect(
      settings.getByRole('combobox', { name: 'Enable automatic retry', exact: true }),
    ).toHaveCount(0)
  }
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({
      path: info.outputPath(`host-settings-desktop-required-${width}.png`),
      fullPage: true,
    })
  }
})
