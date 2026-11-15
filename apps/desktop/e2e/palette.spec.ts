import { test, expect } from '@playwright/test'
import { launch, openWorkspace, shutdown } from './fixtures/local-app'

for (const action of ['Open settings', 'Keyboard shortcuts']) {
  test(`palette ${action} keeps focus in Settings`, async () => {
    const harness = await launch()
    const { page } = harness
    try {
      await openWorkspace(page)
      const composer = page.getByPlaceholder('Describe a task or ask a question')
      await composer.fill('Unsent draft')
      await composer.focus()
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
      await page.getByPlaceholder('Type a command…').fill(action)
      await page.getByRole('button', { name: action, exact: true }).click()
      const search = page.getByRole('combobox', { name: 'Search settings', exact: true })
      await expect(search).toBeFocused()
      await page.keyboard.type('theme')
      await expect(search).toHaveValue('theme')
      await expect(composer).toHaveValue('Unsent draft')
    } finally {
      await shutdown(harness)
    }
  })
}
