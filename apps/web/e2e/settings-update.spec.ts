import { test, expect } from './fixture'

test('Advanced uses the same inline Host update on the PWA', async ({ page, stack }) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  await page.goto(`${stack.origin}/pages/settings/${stack.hostId}`)
  const settings = page.getByTestId('settings-surface')
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Advanced', exact: true })
    .click()
  await settings.getByRole('button', { name: 'Enable configuration access', exact: true }).click()
  await page.getByRole('button', { name: 'Enable for Synthetic Host', exact: true }).click()
  const software = settings.getByRole('region', { name: 'Software', exact: true })
  await expect(software).toContainText('Phosphor Host')
  await software.getByRole('button', { name: 'Update…', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Update Phosphor Host on Synthetic Host?' })
  await expect(confirm).toContainText('waits for working turns')
  await confirm.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(software).toContainText('not installed from a release')
  await expect(page.getByRole('dialog', { name: 'Host update', exact: true })).toHaveCount(0)
  await expect(software.getByText('Show details', { exact: true })).toBeVisible()
})
