import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixture'

async function laneMenu(page: Page, compact: boolean): Promise<void> {
  await page
    .getByRole('button', { name: compact ? /^Lane menu/ : 'Session options', exact: !compact })
    .click()
}

async function expectUncoveredMatch(page: Page, find: Locator, text: string): Promise<void> {
  const match = page.getByTestId('transcript-scroll').getByText(text, { exact: true })
  await expect(match).toBeInViewport()
  await expect
    .poll(async () => {
      const bar = (await find.boundingBox())!
      const text = (await match.boundingBox())!
      return text.y - (bar.y + bar.height)
    })
    .toBeGreaterThanOrEqual(0)
}

for (const width of [400, 1100]) {
  test(`palette and find in a Host chat at ${width}px`, async ({ stack, page }, info) => {
    const compact = width < 900
    await page.setViewportSize({ width, height: 850 })
    await page.goto(stack.origin)
    await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
    await expect(page.getByTestId('compact-shell')).toBeVisible()
    await page.getByRole('button', { name: 'Search lanes and pages', exact: true }).click()
    const palette = page.getByRole('dialog', { name: 'Search lanes and pages', exact: true })
    const input = palette.getByRole('textbox')
    await expect(input).toBeFocused()
    await input.fill('Synthetic acceptance lane')
    const result = palette.getByRole('button', { name: /Open lane: Synthetic acceptance lane/ })
    await expect(result).toContainText('Synthetic Host · repository')
    if (compact) {
      const bounds = await palette.boundingBox()
      expect(bounds?.width).toBe(width)
      expect(bounds?.height).toBe(850)
      expect(Math.round((await result.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    }
    await page.screenshot({ path: info.outputPath(`palette-${width}.png`), animations: 'disabled' })
    await result.click()
    await expect(page).toHaveURL(new RegExp(`/lanes/${stack.hostId}/${stack.laneId}/chat$`))
    await expect(page.getByText('Nobody has control of this lane.', { exact: true })).toBeVisible()
    // Find is a read operation: it works without taking lane control, including from Files.
    await laneMenu(page, compact)
    if (compact)
      await page
        .getByRole('navigation', { name: 'Lane panes' })
        .getByRole('button', { name: 'Files', exact: true })
        .click()
    else {
      await page.keyboard.press('Escape')
      await page
        .getByRole('navigation', { name: 'Lane panes' })
        .getByRole('button', { name: 'Files', exact: true })
        .click()
    }
    await laneMenu(page, compact)
    await page.getByRole('button', { name: 'Find in chat', exact: true }).click()
    const find = page.getByTestId('transcript-find')
    await expect(find).toBeVisible()
    const field = find.getByRole('textbox')
    await expect(field).toBeFocused()
    await field.fill('PHX-synthetic')
    await expect(find.getByTestId('find-status')).toHaveText('1 of 2')
    if (compact) await expectUncoveredMatch(page, find, 'PHX-synthetic artifact')
    await field.press('Enter')
    await expect(find.getByTestId('find-status')).toHaveText('2 of 2')
    if (compact) {
      await expectUncoveredMatch(page, find, 'PHX-synthetic')
      expect((await find.boundingBox())!.width).toBe(width)
      for (const name of ['Previous match', 'Next match', 'Close']) {
        const bounds = await find.getByRole('button', { name, exact: true }).boundingBox()
        expect(Math.round(bounds!.width)).toBeGreaterThanOrEqual(44)
        expect(Math.round(bounds!.height)).toBeGreaterThanOrEqual(44)
      }
    }
    await page.screenshot({ path: info.outputPath(`find-${width}.png`), animations: 'disabled' })
    await find.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(find).toHaveCount(0)
    if (!compact) {
      await page.getByTestId('transcript-scroll').focus()
      await page.keyboard.press('Control+f')
      await expect(find).toBeVisible()
      await field.press('Escape')
      await page.keyboard.press('Control+k')
      await expect(palette).toBeVisible()
      await page.keyboard.press('Escape')
      await page.keyboard.press('Meta+k')
      await expect(palette).toBeVisible()
    } else await page.getByRole('button', { name: 'Search lanes and pages', exact: true }).click()
    await input.fill('Go to Settings')
    await palette.getByRole('button', { name: 'Go to Settings', exact: true }).click()
    await expect(page).toHaveURL(`${stack.origin}/pages/settings/${stack.hostId}`)
    await expect(page.getByRole('combobox', { name: 'Search settings', exact: true })).toBeFocused()
  })
}
