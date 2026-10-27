import { test, expect } from '@playwright/test'
import { accountControlFixture } from './fixtures/account-control'

test('This computer opens a home shell without a lane and Hide preserves it', async () => {
  const h = await accountControlFixture()
  const { page } = h
  try {
    // The fixture isolates Electron's HOME; it is not the Playwright runner's home.
    const home = await h.app.evaluate(() => process.env.HOME as string)
    await page.getByRole('button', { name: 'Machines', exact: true }).click()
    await page.getByTestId('local-machine-row').click()
    const card = page.getByRole('region', { name: 'Terminal', exact: true })
    await card.getByRole('button', { name: 'Open terminal', exact: true }).click()
    const view = page.getByTestId('machine-terminal')
    await expect(view.locator('.xterm-helper-textarea')).toBeAttached()
    await view.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('PHOSPHOR_KEEP=preserved; printf \'cwd=%s\\n\' "$PWD"')
    await page.keyboard.press('Enter')
    await expect(view.locator('.xterm-rows')).toContainText(`cwd=${home}`)
    await card.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(view).toHaveCount(0)
    await card.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await view.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf \'shell_%s\\n\' "$PHOSPHOR_KEEP"')
    await page.keyboard.press('Enter')
    await expect(view.locator('.xterm-rows')).toContainText('shell_preserved')
    await card.getByRole('button', { name: 'End shell', exact: true }).click()
    await expect(view).toHaveCount(0)
  } finally {
    await h.close()
  }
})
