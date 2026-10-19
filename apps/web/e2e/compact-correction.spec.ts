import { test, expect } from './fixture'

test('Machines detail has a compact hierarchy and Lanes uses Desktop repository rows', async ({
  page,
  stack,
}, info) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  for (const width of [360, 412, 768, 1440]) {
    await page.setViewportSize({ width, height: 850 })
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        async (value) => {
          await window.phosphor.invoke('app:setTheme', value)
        },
        theme as 'light' | 'dark',
      )
      await page.goto(`${stack.origin}/pages/machines`)
      await page.getByRole('button', { name: /Synthetic Host/ }).click()
      const detail = page.getByTestId('machine-detail')
      await expect(
        detail.getByRole('heading', { name: 'Synthetic Host', exact: true }),
      ).toBeVisible()
      await expect(page.locator('.page-shell h1')).toHaveCount(1)
      await expect(page.getByRole('button', { name: 'Back to machines', exact: true })).toHaveCount(
        1,
      )
      await expect(page.getByRole('button', { name: 'Add a machine', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Check again', exact: true })).toHaveCount(0)
      const header = detail.locator('.machine-detail-header')
      const bounds = await header.boundingBox()
      expect(bounds?.y).toBeLessThan(180)
      expect(bounds?.height).toBeLessThan(100)
      expect(
        await detail
          .getByRole('heading', { name: 'Synthetic Host', exact: true })
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
      ).toBeLessThanOrEqual(24)
      await expect(detail.locator('.machine-facts')).not.toHaveAttribute('open')
      expect(await detail.locator('.machine-lane-preview .lane-row').count()).toBeLessThanOrEqual(3)
      await page.screenshot({
        path: info.outputPath(`compact-detail-${width}-${theme}.png`),
        fullPage: true,
      })
      await detail.getByRole('button', { name: 'Machine actions', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Check again', exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await page.goto(`${stack.origin}/lanes/${stack.hostId}`)
      const repository = page.getByRole('region', { name: 'repository', exact: true })
      const other = page.getByRole('region', { name: 'other', exact: true })
      await expect(
        repository.getByRole('button', { name: 'Synthetic acceptance lane', exact: true }),
      ).toBeVisible()
      await expect(
        other.getByRole('button', { name: 'Second synthetic lane', exact: true }),
      ).toBeVisible()
      for (const row of [repository.locator('.lane-row'), other.locator('.lane-row')]) {
        await expect(row).not.toContainText('stopped')
        await expect(row).not.toContainText('Needs attention')
        await expect(row).toContainText(/now|\d+[smhdw]/)
      }
      await repository.getByRole('button', { name: 'repository', exact: true }).click()
      await expect(repository.locator('.lane-row')).toHaveCount(0)
      await expect(other.locator('.lane-row')).toBeVisible()
      await repository.getByRole('button', { name: 'repository', exact: true }).click()
      await page.screenshot({
        path: info.outputPath(`compact-lanes-${width}-${theme}.png`),
        fullPage: true,
      })
    }
  }
})

test('Install action has manual fallback and only reports completion on appinstalled', async ({
  page,
  stack,
}) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Install Phosphor', exact: true }).click()
  const help = page.getByRole('dialog', { name: 'Install Phosphor', exact: true })
  await expect(help).toContainText('An automatic prompt is not guaranteed')
  await help.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeVisible()
  await page.goto(`${stack.origin}/pages/settings`)
  await expect(page.getByRole('heading', { name: 'App installation', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    })
    window.dispatchEvent(event)
  })
  await page.getByRole('button', { name: 'Install Phosphor', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('Finish installation in your browser')
  await expect(
    page.getByRole('button', { name: 'Install Phosphor', exact: true }).last(),
  ).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')))
  await expect(page.getByRole('button', { name: 'Install Phosphor', exact: true })).toHaveCount(0)
})
