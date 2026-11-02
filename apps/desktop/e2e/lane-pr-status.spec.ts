import { test, expect } from '@playwright/test'
import { launch, shutdown, openWorkspace } from './fixtures/local-app'

test('active lane PR details support keyboard refresh and survive failures with sidebar hidden', async () => {
  const h = await launch()
  try {
    await h.app.evaluate(({ ipcMain }, workspace) => {
      const state = globalThis as unknown as { lanePrFails: boolean }
      state.lanePrFails = false
      ipcMain.removeHandler('gh:available')
      ipcMain.handle('gh:available', () => true)
      ipcMain.removeHandler('gh:prsForRepo')
      ipcMain.handle('gh:prsForRepo', () =>
        state.lanePrFails
          ? null
          : {
              byBranch: {
                feature: {
                  number: 42,
                  title: 'Lane PR keyboard test',
                  state: 'OPEN',
                  url: 'https://github.com/example/repo/pull/42',
                  checks: { passed: 2, failed: 0, pending: 0, total: 2 },
                  reviewDecision: 'REVIEW_REQUIRED',
                  mergeable: 'MERGEABLE',
                },
              },
              complete: true,
            },
      )
      ipcMain.removeHandler('git:infoBatch')
      ipcMain.handle('git:infoBatch', (_event, cwds: string[]) =>
        Object.fromEntries(
          cwds.map((cwd) => [cwd, { isRepo: true, mainRepoPath: workspace, branch: 'feature' }]),
        ),
      )
    }, h.workspace)
    await h.page.reload()
    await openWorkspace(h.page)
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await h.page.getByRole('button', { name: /Start lane/i }).click()
    const pill = h.page.getByTestId('lane-pr-status')
    await expect(pill).toHaveText('#42 ✓')
    await h.page.getByRole('button', { name: /^Hide sidebar/ }).click()
    await pill.focus()
    await pill.press('Enter')
    const details = h.page.getByRole('region', { name: 'Pull request details' })
    await expect(details).toContainText('Review: required')
    await expect(details.getByRole('button', { name: 'Open on GitHub' })).toBeFocused()
    await h.page.keyboard.press('Tab')
    await expect(details.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused()
    await h.app.evaluate(() => {
      ;(globalThis as unknown as { lanePrFails: boolean }).lanePrFails = true
    })
    await h.page.keyboard.press('Space')
    await expect(details).toContainText('Last app attempt failed')
    await expect(pill).toContainText('#42')
    await h.app.evaluate(() => {
      ;(globalThis as unknown as { lanePrFails: boolean }).lanePrFails = false
    })
    await details.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(details).not.toContainText('Last app attempt failed')
    await h.page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
    await expect(pill).toBeFocused()
    expect(
      await h.page
        .locator('header')
        .first()
        .evaluate((header) => header.getBoundingClientRect().height),
    ).toBe(44)
  } finally {
    await shutdown(h)
  }
})
