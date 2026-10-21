import { test, expect } from '@playwright/test'
import { homedir } from 'node:os'
import { accountControlFixture } from './fixtures/account-control'

test('This computer opens a home shell without a lane and Hide preserves it', async () => {
  const h = await accountControlFixture()
  const { page } = h
  try {
    await page.getByRole('button', { name: 'Machines', exact: true }).click()
    await page.getByTestId('local-machine-row').click()
    const card = page.getByRole('region', { name: 'Terminal', exact: true })
    await card.getByRole('button', { name: 'Open terminal', exact: true }).click()
    const view = page.getByTestId('machine-terminal')
    await expect(view.locator('.xterm-helper-textarea')).toBeAttached()
    await view.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('printf \'%s\\n\' "$HOME"')
    await page.keyboard.press('Enter')
    await expect(view.locator('.xterm-rows')).toContainText(homedir())
    await card.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(view).toHaveCount(0)
    await card.getByRole('button', { name: 'Open terminal', exact: true }).click()
    await expect(view.locator('.xterm-rows')).toContainText(homedir())
    await card.getByRole('button', { name: 'End shell', exact: true }).click()
    await expect(view).toHaveCount(0)
  } finally {
    await h.close()
  }
})
