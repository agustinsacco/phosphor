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
      const input = page.getByPlaceholder('Type a command…')
      await expect(input).toHaveCSS('font-size', '13.5px')
      await input.fill(action)
      await page.getByRole('button', { name: new RegExp(`^${action}`) }).click()
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

test('Find in chat exits a fullscreen pane and focuses the visible transcript bar', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('Hello')
    await page.getByRole('button', { name: /Start lane/i }).click()
    await expect(page.getByText(/Done:\s*hello\.ts\s*updated\./)).toBeVisible()
    await page.getByRole('button', { name: /Files pane/ }).click()
    await page.getByRole('button', { name: 'Fullscreen pane', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Session options', exact: true }).click()
    await page.getByRole('button', { name: 'Find in chat', exact: true }).click()
    const find = page.getByTestId('transcript-find')
    await expect(find.getByRole('textbox')).toBeFocused()
    await expect(page.getByRole('button', { name: 'Fullscreen pane', exact: true })).toBeVisible()
    await find.getByRole('textbox').fill('updated')
    await expect(find.getByTestId('find-status')).toHaveText(/^1 of \d+/)
  } finally {
    await shutdown(harness)
  }
})
