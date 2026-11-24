import { expect } from '@playwright/test'
import { settings, shot, source } from './capture-harness.mjs'

// The full capture run may have visited other pages since the Brain setup shot.
export async function captureRecall(page) {
  await settings(page, 'brain')
  await page.getByRole('button', { name: 'Open Brain', exact: true }).click()
  const question = page.getByRole('textbox', { name: 'Ask Brain, or tell Brain Agent' })
  const theme = await page.evaluate(async (source) => {
    const { useSettingsStore } = await import(`${source}stores/settings.ts`)
    const previous = useSettingsStore.getState().theme
    useSettingsStore.getState().setTheme('light')
    return previous
  }, source)
  await question.fill('Who took over billing for Harbor?')
  await question.press('Enter')
  const answer = page.getByRole('region', { name: 'Answer' })
  await expect(answer).toContainText('Tom Lee took over Harbor ledger from Rina Okafor.')
  await expect(page.locator('[data-edge][data-lit="true"]').first()).toBeAttached()
  await answer.getByRole('heading').scrollIntoViewIfNeeded()
  await shot(page, 'brain-recall', page.locator('.page-shell').filter({ has: answer }))
  await page.evaluate(
    async ({ source, theme }) => {
      const { useSettingsStore } = await import(`${source}stores/settings.ts`)
      useSettingsStore.getState().setTheme(theme)
    },
    { source, theme },
  )
}
