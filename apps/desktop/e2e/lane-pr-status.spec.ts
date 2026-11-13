import { test, expect } from '@playwright/test'
import { launch, shutdown, openWorkspace } from './fixtures/local-app'

/** One PR on the lane's checkout branch; `lanePrFails` makes every read of it fail. */
async function stubFailingLanePr(h: Awaited<ReturnType<typeof launch>>): Promise<void> {
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
    // Read by number, GitHub adds nothing; failing, the PR's own read says so.
    ipcMain.removeHandler('gh:prSummaries')
    ipcMain.handle('gh:prSummaries', () => (state.lanePrFails ? null : { byKey: {}, coverage: {} }))
    ipcMain.removeHandler('gh:prDetail')
    ipcMain.handle('gh:prDetail', () => null)
    ipcMain.removeHandler('git:infoBatch')
    ipcMain.handle('git:infoBatch', (_event, cwds: string[]) =>
      Object.fromEntries(
        cwds.map((cwd) => [cwd, { isRepo: true, mainRepoPath: workspace, branch: 'feature' }]),
      ),
    )
  }, h.workspace)
}

test('active lane PR details support keyboard refresh and survive failures with sidebar hidden', async () => {
  const h = await launch()
  try {
    await stubFailingLanePr(h)
    await h.page.reload()
    await openWorkspace(h.page)
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await h.page.getByRole('button', { name: /Start lane/i }).click()
    const pill = h.page.getByTestId('lane-pr-status')
    await expect(pill).toHaveText('#42')
    await expect(pill).toHaveAttribute('data-variant', 'review')
    await expect(pill).toHaveAttribute('aria-label', 'Pull request #42: Waiting for review.')
    await h.page.getByRole('button', { name: /^Hide sidebar/ }).click()
    await pill.focus()
    await pill.press('Enter')
    const details = h.page.getByRole('region', { name: 'Pull request details' })
    await expect(details).toContainText('Review required')
    // Tab order: the list, Track a PR…, the tabs, the panel, then the header's actions.
    await expect(details.getByRole('option', { name: /#42/ })).toBeFocused()
    await h.page.keyboard.press('Tab')
    await expect(details.getByRole('button', { name: 'Track a PR…' })).toBeFocused()
    await h.page.keyboard.press('Tab')
    await expect(details.getByRole('tab', { name: 'Overview' })).toBeFocused()
    await h.page.keyboard.press('Tab')
    await expect(details.getByRole('tabpanel')).toBeFocused()
    await h.page.keyboard.press('Tab')
    await expect(details.getByRole('button', { name: 'Open on GitHub' })).toBeFocused()
    await h.page.keyboard.press('Tab')
    await h.page.keyboard.press('Tab')
    const refresh = details.getByRole('button', { name: 'Refresh', exact: true })
    await expect(refresh).toBeFocused()
    await h.app.evaluate(() => {
      ;(globalThis as unknown as { lanePrFails: boolean }).lanePrFails = true
    })
    await h.page.keyboard.press('Space')
    await expect(details.getByTestId('pr-inspector-stale')).toBeVisible()
    await expect(pill).toContainText('#42')
    await h.app.evaluate(() => {
      ;(globalThis as unknown as { lanePrFails: boolean }).lanePrFails = false
    })
    await refresh.click()
    await expect(details.getByTestId('pr-inspector-stale')).toHaveCount(0)
    await expect(details).toContainText('checked')
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

const SUBAGENT_PR = { host: 'github.com', owner: 'example', repo: 'repo', number: 20244 }
/** A by-number read of a PR opened from a branch the worktree never checked out. */
const subagentSummary = () => ({
  ref: SUBAGENT_PR,
  number: 20244,
  title: 'Add a knowledge-service CLI',
  state: 'OPEN',
  url: 'https://github.com/example/repo/pull/20244',
  mergeable: 'MERGEABLE',
  reviewDecision: 'REVIEW_REQUIRED',
  checks: { passed: 2, failed: 1, pending: 0, total: 3 },
  headRefName: 'agustin/knowledge-cli',
  baseRefName: 'main',
  ...{ additions: 1, deletions: 1, changedFiles: 1, comments: 0 },
  updatedAt: new Date().toISOString(),
  checkRuns: [
    { name: 'build', state: 'success', required: true },
    { name: 'Rocky review', state: 'failure', required: false },
  ],
  ...{ checksTruncated: false, approvedBy: [], changesRequestedBy: [], waitingOn: [] },
  ...{ threads: { total: 0, unresolved: 0 }, inMergeQueue: false, autoMerge: false },
})
/** The scan's view of a lane whose subagent opened that PR. */
const governanceLane = (workspace: string) => ({
  path: `${workspace}/governance.jsonl`,
  sessionId: 'governance',
  cwd: workspace,
  name: 'Governance',
  createdAt: new Date().toISOString(),
  lastActivityAt: new Date().toISOString(),
  ...{ mtimeMs: Date.now(), userMessages: 1, assistantMessages: 1, toolCalls: 1 },
  ...{ totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  ...{ cacheWriteTokens: 0, cost: 0, headroomSavedTokens: 0, entryCount: 3, branchCount: 0 },
  pullRequests: {
    ...{ opened: [SUBAGENT_PR], branches: ['agustin/knowledge-cli'] },
    ...{ reviewing: [], mentioned: [], pinned: [], hidden: [] },
  },
})

test('a lane shows the PR its subagent opened from another branch, read by number', async () => {
  const h = await launch()
  try {
    const fixture = {
      workspace: h.workspace,
      lane: governanceLane(h.workspace),
      summary: subagentSummary(),
    }
    await h.app.evaluate(({ ipcMain }, { workspace, lane, summary }) => {
      const state = globalThis as unknown as { asked: unknown[] }
      state.asked = []
      const key = 'github.com/example/repo#20244'
      const found = { state: 'found', checkedAt: Date.now(), attemptedAt: Date.now() }
      ipcMain.removeHandler('gh:available')
      ipcMain.handle('gh:available', () => true)
      // The worktree's own branch never had a PR.
      ipcMain.removeHandler('gh:prsForRepo')
      ipcMain.handle('gh:prsForRepo', () => ({ byBranch: {}, complete: true }))
      ipcMain.removeHandler('gh:prSummaries')
      ipcMain.handle('gh:prSummaries', (_event, refs: unknown[]) => {
        state.asked.push(...refs)
        return { byKey: { [key]: summary }, coverage: { [key]: found } }
      })
      ipcMain.removeHandler('git:infoBatch')
      ipcMain.handle('git:infoBatch', () => ({
        [workspace]: { isRepo: true, isWorktree: true, mainRepoPath: workspace, branch: 'scratch' },
      }))
      ipcMain.removeHandler('sessions:list')
      ipcMain.handle('sessions:list', (_event, cwd) => (cwd === workspace ? [lane] : []))
    }, fixture)
    await h.page.reload()
    await openWorkspace(h.page)
    const badge = h.page.getByTestId('session-row').getByTestId('session-pr-badge')
    await expect(badge).toHaveText(/#20244/)
    await expect(badge).toHaveAttribute('data-variant', 'failing')
    const asked = await h.app.evaluate(() => (globalThis as unknown as { asked: unknown[] }).asked)
    expect(asked).toContainEqual(SUBAGENT_PR)
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
  } finally {
    await shutdown(h)
  }
})
