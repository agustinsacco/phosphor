import { test, expect } from '@playwright/test'
import { remoteHostFixture } from './fixtures/remote-host'
import { openRemote, takeControl, files, file } from './fixtures/remote-ui'

test('Background attention and sign-out preserve machine boundaries', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await h.page.getByRole('button', { name: 'Machine filter', exact: true }).click()
    await h.page.getByRole('option').filter({ hasText: 'This Mac' }).click()
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('LOCAL_ONLY task')
    await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect(h.page.getByTestId('session-row').filter({ hasText: 'LOCAL_ONLY' })).toBeVisible()
    await h.backgroundTurn('PHX-background')
    await expect
      .poll(() =>
        h.frames.some(
          (f) =>
            f.type === 'lanes-delta' &&
            f.upsert.some((lane) => lane.laneId === h.laneId && lane.attention > lane.read),
        ),
      )
      .toBe(true)
    // Baseline has only an indicator tooltip; parity row-menu work may add a labelled badge.
    await h.page.getByRole('button', { name: 'Machine filter', exact: true }).click()
    await h.page.getByRole('option').filter({ hasText: 'bee1' }).click()
    const row = h.page
      .getByRole('region', { name: 'bee1', exact: true })
      .getByRole('button', { name: /Remote test lane/ })
    await expect(row.locator('[data-tooltip="New activity"]')).toBeVisible()
    const notification = h.page.getByRole('button', {
      name: 'Open lane: bee1 · Remote test lane',
      exact: true,
    })
    await expect(notification).toHaveCount(1)
    await notification.click()
    await expect(h.page.locator('main').getByText('PHX-background', { exact: true })).toHaveCount(2)
    await expect(row.locator('[data-tooltip="New activity"]')).toHaveCount(0)
    await expect
      .poll(() =>
        h.frames.some(
          (f) =>
            f.type === 'lanes-delta' &&
            f.upsert.some(
              (lane) =>
                lane.laneId === h.laneId && lane.attention > 0 && lane.attention === lane.read,
            ),
        ),
      )
      .toBe(true)
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY')
    await h.page.getByRole('button', { name: 'Your account', exact: true }).click()
    await h.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await expect(h.page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect(h.page.getByRole('region', { name: 'bee1', exact: true })).toHaveCount(0)
    await expect(h.page.locator('.monaco-editor')).toHaveCount(0)
    await expect(h.page.locator('main').getByText('PHX-background', { exact: true })).toHaveCount(0)
    // Signing out returns to local home, whose composer is intentionally still usable.
    await expect(h.page.getByRole('button', { name: 'Take control', exact: true })).toHaveCount(0)
    await expect(h.page.getByText('Controlled by Second client', { exact: true })).toHaveCount(0)
    await h.page.getByTestId('session-row').filter({ hasText: 'LOCAL_ONLY' }).click()
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible()
    await h.signIn()
    await openRemote(h)
    await expect(h.page.locator('main').getByText('PHX-background', { exact: true })).toHaveCount(2)
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test.fixme('Provider login and error remedies target bee1, Settings is This Mac (phase 2)', async () => {
  // trigger remote auth error, click Sign in on bee1→Machines/readiness; provider login terminal
  // visibly names bee1, finishes and readiness becomes signed in, retry succeeds. Assert no local
  // login terminal. Open machine-scoped Settings tabs: This Mac scope visible; Accounts links bee1
  // readiness; no unhandled rejection, Host meter unaffected by Mac budget change. Capture auth
  // remedy and scope banner both themes.
})
