import { test, expect } from '@playwright/test'
import { accountControlFixture } from './fixtures/account-control'

test('the Terminal tab opens a home shell, keeps it across tabs, and ends it on close', async () => {
  const h = await accountControlFixture()
  const { page } = h
  try {
    // The fixture isolates Electron's HOME; it is not the Playwright runner's home.
    const home = await h.app.evaluate(() => process.env.HOME as string)
    await page.getByRole('button', { name: 'Machines', exact: true }).click()
    await page.getByTestId('local-machine-row').click()
    const views = page.getByRole('navigation', { name: 'Machine views' })
    const pane = page.getByTestId('machine-terminal')
    // The shell is a view of its own, and opening the view opens the shell.
    await views.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(pane.locator('.xterm-helper-textarea')).toBeAttached()
    await pane.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('PHOSPHOR_KEEP=preserved; printf \'cwd=%s\\n\' "$PWD"')
    await page.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText(`cwd=${home}`)
    // Overview is a different view, not a detach: the shell keeps running.
    await views.getByRole('button', { name: 'Overview', exact: true }).click()
    await expect(pane).toHaveCount(0)
    await views.getByRole('button', { name: 'Terminal', exact: true }).click()
    await pane.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf \'shell_%s\\n\' "$PHOSPHOR_KEEP"')
    await page.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText('shell_preserved')
    // Closing the tab is what ends the shell: the pane is left without one,
    // and the next shell starts clean.
    const tab = pane.locator('div.group', { hasText: 'Terminal 1' })
    await tab.hover()
    await tab.getByRole('button', { name: 'Close Terminal 1', exact: true }).click()
    await expect(pane.locator('.xterm-rows')).toHaveCount(0)
    await pane.getByRole('button', { name: 'New terminal', exact: true }).click()
    await pane.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf \'shell_%s\\n\' "${PHOSPHOR_KEEP:-gone}"')
    await page.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText('shell_gone')
  } finally {
    await h.close()
  }
})
