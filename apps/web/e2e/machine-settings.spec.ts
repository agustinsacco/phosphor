import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixture'

/** The Host's Machines entry opens the shared Settings page, scoped to that Host. */
async function openSettings(page: Page, origin: string, name: string) {
  await page.goto(`${origin}/pages/machines`)
  await page.getByRole('button', { name: /Synthetic Host/ }).click()
  await page
    .getByRole('navigation', { name: 'Machine views' })
    .getByRole('button', { name: 'Machine settings', exact: true })
    .click()
  await expect(page).toHaveURL(/\/pages\/settings\/[^/]+$/)
  const settings = page.getByTestId('settings-surface')
  await expect(settings.getByTestId('settings-machine-scope')).toContainText(
    'Configuring Synthetic Host',
  )
  await section(settings, name)
  return settings
}

async function section(settings: Locator, name: string) {
  await settings
    .getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name, exact: true })
    .click()
}

test('browser Host settings load only after explicit configuration access', async ({
  page,
  stack,
}, info) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  let settings = await openSettings(page, stack.origin, 'Accounts')
  // Lane access alone never configures the Host: nothing loads before the opt-in.
  await expect(settings).toContainText('Configuration access is not enabled')
  await expect(settings).not.toContainText('available in Phosphor Desktop')
  await expect(settings.getByRole('heading', { name: 'Accounts', exact: true })).toHaveCount(0)
  const grantsBefore = stack.state.grants
  await settings.getByRole('button', { name: 'Enable configuration access', exact: true }).click()
  await page.getByRole('button', { name: 'Enable for Synthetic Host', exact: true }).click()
  await expect(settings.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible()
  expect(stack.state.grants).toBeGreaterThan(grantsBefore)
  // Claude Code is listed under Extensions on a Host too, with the same page.
  await section(settings, 'Claude Code')
  await expect(
    settings.getByRole('heading', { name: 'Claude Code provider', exact: true }),
  ).toBeVisible()
  await section(settings, 'Agent')
  await expect(settings.getByRole('heading', { name: 'Agent defaults', exact: true })).toBeVisible()
  // An edit saves itself, as Desktop's settings do, and says where it landed.
  const retry = settings.getByRole('switch', { name: 'Retry on transient errors', exact: true })
  await retry.click()
  await expect(page.getByTestId('toast-stack')).toContainText(
    'Saved on Synthetic Host — applies to new lanes',
  )
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(retry).toHaveAttribute('aria-checked', 'false')
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    expect(await settings.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    // A sourced control (badge, select, Reset) fits the row on a phone, Reset included.
    await expect(
      settings.getByRole('combobox', { name: 'Default model', exact: true }),
    ).toBeVisible()
    await expect(
      settings.getByRole('button', { name: 'Reset Default model', exact: true }),
    ).toBeInViewport({ ratio: 1 })
    // The select gives way, not the words: the badge and Reset each stay on one line.
    const lines = (locator: Locator) =>
      locator.evaluate((el) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size
      })
    expect(await lines(settings.getByText('Set here', { exact: true }).first())).toBe(1)
    expect(
      await lines(settings.getByRole('button', { name: 'Reset Default model', exact: true })),
    ).toBe(1)
    await page.screenshot({
      path: info.outputPath(`host-settings-browser-access-${width}.png`),
      fullPage: true,
    })
  }
  // The opt-in lives in this page's memory only: a new document (page.goto) starts without it.
  settings = await openSettings(page, stack.origin, 'Accounts')
  await expect(settings).toContainText('Configuration access is not enabled')
})
