import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

async function openSettings(page: Page, origin: string, name: string) {
  await page.goto(`${origin}/pages/machines`)
  await page.getByRole('button', { name: /Synthetic Host/ }).click()
  await page
    .getByRole('navigation', { name: 'Machine views' })
    .getByRole('button', { name: 'Machine settings', exact: true })
    .click()
  const settings = page.getByTestId('machine-settings')
  await settings
    .getByRole('navigation', { name: 'Machine settings', exact: true })
    .getByRole('button', { name, exact: true })
    .click()
  return settings
}

test('browser Host settings load only after explicit configuration access', async ({
  page,
  stack,
}, info) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  let settings = await openSettings(page, stack.origin, 'Providers')
  // Lane access alone never configures the Host: nothing loads before the opt-in.
  await expect(settings).toContainText('Configuration access is not enabled')
  await expect(settings).not.toContainText('available in Phosphor Desktop')
  await expect(settings.getByRole('heading', { name: 'Providers', exact: true })).toHaveCount(0)
  const grantsBefore = stack.state.grants
  await settings.getByRole('button', { name: 'Enable configuration access', exact: true }).click()
  await page.getByRole('button', { name: 'Enable for Synthetic Host', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible()
  expect(stack.state.grants).toBeGreaterThan(grantsBefore)
  await settings
    .getByRole('navigation', { name: 'Machine settings', exact: true })
    .getByRole('button', { name: 'Agent defaults', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Agent defaults', exact: true })).toBeVisible()
  // An edit saves itself, as Desktop's settings do, and says where it landed.
  const retry = settings.getByRole('combobox', { name: 'Enable automatic retry', exact: true })
  await retry.selectOption('false')
  await expect(page.getByTestId('toast-stack')).toContainText(
    'Saved on Synthetic Host — applies to new lanes',
  )
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(retry).toHaveValue('false')
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({
      path: info.outputPath(`host-settings-browser-access-${width}.png`),
      fullPage: true,
    })
  }
  // The opt-in lives in this page's memory only: a new document (page.goto) starts without it.
  settings = await openSettings(page, stack.origin, 'Providers')
  await expect(settings).toContainText('Configuration access is not enabled')
})
