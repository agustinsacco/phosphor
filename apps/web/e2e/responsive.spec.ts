import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

async function assertContained(page: Page): Promise<void> {
  const sizes = await page
    .locator('.browser-content, .compact-main, .page-body-content, .remote-start')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
      })),
    )
  expect(
    sizes.every((size) => size.scroll <= size.width + 1),
    JSON.stringify(sizes),
  ).toBe(true)
}

test('shared full pages fit phone, tablet and wide layouts with consistent font metrics', async ({
  stack,
  page,
}, info) => {
  test.setTimeout(120_000)
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  for (const width of [360, 412, 768, 1440]) {
    await page.setViewportSize({ width, height: 924 })
    await expect(page.locator('html')).toHaveAttribute(
      'data-form-factor',
      width < 900 ? 'compact' : 'expanded',
    )
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate(async (value) => {
        await window.phosphor.invoke('app:setTheme', value)
      }, theme)
      // Hydrate the preference through the same reload path as a returning browser.
      await page.goto(`${stack.origin}/new/${stack.hostId}`)
      await expect(page.getByTestId('remote-model-picker')).toContainText('HOST_A_ONLY')
      await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
      await page.evaluate(() => document.fonts.ready)
      expect(await page.evaluate(() => document.fonts.check('14px Inter'))).toBe(true)
      await assertContained(page)
      await page.screenshot({ path: info.outputPath(`home-${width}-${theme}.png`), fullPage: true })
      for (const route of ['machines', 'settings', 'routines', 'skills', 'artifacts']) {
        await page.goto(
          `${stack.origin}/pages/${route}/${route === 'machines' ? '' : stack.hostId}`.replace(
            /\/$/,
            '',
          ),
        )
        await expect(page.locator('.page-shell h1')).toHaveCount(1)
        await assertContained(page)
        await page.screenshot({
          path: info.outputPath(`${route}-${width}-${theme}.png`),
          fullPage: true,
        })
        if (route === 'machines') {
          await page.getByRole('button', { name: /Synthetic Host/ }).click()
          await expect(
            page.getByRole('heading', { name: 'Synthetic Host', exact: true }),
          ).toBeVisible()
          await assertContained(page)
          await page.screenshot({
            path: info.outputPath(`detail-${width}-${theme}.png`),
            fullPage: true,
          })
        }
      }
    }
  }
  expect(failures).toEqual([])
})

test('browser creation rejects file uploads before mutation and offers no isolation toggle', async ({
  stack,
  page,
}) => {
  const failures: string[] = []
  page.on('pageerror', (error) => failures.push(error.message))
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  const before = await page.evaluate(() => window.phosphor.invoke('hosts:snapshot'))
  const picking = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await (
    await picking
  ).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') })
  await expect(page.getByRole('alert')).toContainText('Only images can be attached in this browser')
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeDisabled()
  const checkbox = page.locator('.remote-start input[type="checkbox"]')
  // The first folder is not a git repository: no branch, the lane runs in it.
  await expect(page.getByText('no git · runs in folder', { exact: true })).toBeVisible()
  await expect(checkbox).toHaveCount(0)
  await page.getByRole('button', { name: 'Repository', exact: true }).click()
  await page.getByRole('option', { name: 'other', exact: true }).click()
  // A git repository: every Host lane gets a worktree, so nothing to opt out of.
  await expect(page.getByText('no git · runs in folder', { exact: true })).toHaveCount(0)
  await expect(checkbox).toHaveCount(0)
  await page.getByRole('button', { name: 'Repository', exact: true }).click()
  // The Host's folder dialog is the same one Desktop opens; looking does not mutate.
  await page.getByRole('option', { name: /^Add folder on/ }).click()
  await expect(page.getByText("Choose a folder under this machine's home directory.")).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  // Phones and wide browsers open the same model menu as Desktop; a phone's is a sheet.
  await page.getByTestId('remote-model-picker').click()
  await expect(page.locator('[data-compact-menu] [data-testid="model-list"]')).toBeVisible()
  await page.getByTestId('model-search').fill('no-such-model')
  await expect(page.getByText('No models match “no-such-model”.')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 1280, height: 850 })
  await expect(page.locator('html')).toHaveAttribute('data-form-factor', 'expanded')
  await page.getByTestId('remote-model-picker').click()
  await page.getByTestId('model-search').fill('no-such-model')
  await expect(page.getByText('No models match “no-such-model”.')).toBeVisible()
  await page.keyboard.press('Escape')
  const after = await page.evaluate(() => window.phosphor.invoke('hosts:snapshot'))
  expect(after[stack.hostId]?.lanes).toEqual(before[stack.hostId]?.lanes)
  const imagePicker = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await (
    await imagePicker
  ).setFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/RsAAAAASUVORK5CYII=',
      'base64',
    ),
  })
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Start lane', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[stack.hostId]?.lanes
          .length,
    )
    .toBe((before[stack.hostId]?.lanes.length ?? 0) + 1)
  expect(failures).toEqual([])
})
