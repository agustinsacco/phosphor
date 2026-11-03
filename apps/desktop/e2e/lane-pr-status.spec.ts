import { test, expect, type Page } from '@playwright/test'

/** Focus inside a header popup must never scroll the page (overflow: hidden stops users, not focus). */
const pageScroll = (page: Page): Promise<number> =>
  page.evaluate(() => (document.scrollingElement?.scrollTop ?? 0) + document.body.scrollTop)
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
    expect(await pageScroll(h.page)).toBe(0)
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
    expect(await pageScroll(h.page)).toBe(0)
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

test('a Slack thread in the lane prompt is a header quick link that opens and adds to the message', async () => {
  const h = await launch()
  const thread = 'https://acme.slack.com/archives/C0123ABC/p1730563200123456'
  try {
    await h.app.evaluate(({ shell }) => {
      const state = globalThis as unknown as { openedUrls: string[] }
      state.openedUrls = []
      shell.openExternal = async (url) => {
        state.openedUrls.push(url)
      }
    })
    await openWorkspace(h.page)
    await h.page
      .getByPlaceholder('Describe a task or ask a question')
      .fill(`fix what they asked in ${thread}#junk`)
    await h.page.getByRole('button', { name: /Start lane/i }).click()
    const slack = h.page.locator('header').getByTestId('lane-slack-threads')
    await expect(slack).toHaveAttribute('aria-label', '1 Slack thread in context')
    await slack.click()
    const list = h.page.getByRole('region', { name: 'Slack threads in this lane' })
    await expect(list).toContainText('fix what they asked in')
    await expect(list.getByTestId('slack-thread-open')).toBeFocused()
    expect(await pageScroll(h.page)).toBe(0)
    await list.getByTestId('slack-thread-open').click()
    await expect
      .poll(() =>
        h.app.evaluate(() => (globalThis as unknown as { openedUrls: string[] }).openedUrls),
      )
      .toEqual([thread])
    await slack.click()
    await list.getByRole('button', { name: /^Add .* to message$/ }).click()
    const composer = h.page.locator('[data-composer-input]')
    await expect(composer).toHaveValue(`${thread} `)
    await expect(composer).toBeFocused()
    expect(await pageScroll(h.page)).toBe(0)
  } finally {
    await shutdown(h)
  }
})
