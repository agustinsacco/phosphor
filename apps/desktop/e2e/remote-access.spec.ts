import { test, expect } from '@playwright/test'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { openRemote, takeControl, files, file, captures } from './fixtures/remote-ui'

test('Background attention and sign-out preserve machine boundaries', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
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
    await h.page.getByRole('button', { name: 'Routines', exact: true }).click()
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
    const row = h.page
      .getByRole('region', { name: 'bee1', exact: true })
      .getByRole('button', { name: /Remote test lane/ })
    const notification = h.page.getByRole('button', {
      name: 'Open lane: bee1 · Remote test lane',
      exact: true,
    })
    await expect(notification).toHaveCount(1)
    await notification.click()
    await expect(h.page.getByRole('button', { name: 'Machine filter', exact: true })).toContainText(
      'bee1',
    )
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

test('Provider login and error remedies target bee1, Settings is This Mac', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  const errors: string[] = []
  try {
    h.page.on('pageerror', (error) => errors.push(error.message))
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('auth-error')
    await chat.press('Enter')
    await expect(h.page.getByRole('button', { name: 'Sign in on bee1', exact: true })).toBeVisible()
    await captures(h, info, 'remote-auth-remedy')
    await h.page.getByRole('button', { name: 'Sign in on bee1', exact: true }).click()
    await expect(h.page.locator('main')).toContainText('bee1')
    await expect(h.page.locator('main')).toContainText('Readiness')
    await expect(h.page.locator('.xterm')).toHaveCount(0)
    const provider = h.page.locator('[data-provider="openai-codex"]')
    await expect(provider.locator('[data-tone]')).toHaveText('Not signed in')
    if (await provider.getByRole('button', { name: 'Sign in', exact: true }).count()) {
      await provider.getByRole('button', { name: 'Sign in', exact: true }).click()
      const login = h.page.getByRole('dialog', { name: 'Provider sign-in', exact: true })
      await expect(login).toContainText('Type /login openai-codex')
      await expect(login.locator('.xterm')).toContainText('HOST_A_ONLY provider login')
      const input = login.locator('.xterm-helper-textarea')
      await input.focus()
      await input.pressSequentially('/login openai-codex', { delay: 5 })
      await input.press('Enter')
      await expect(login.locator('.xterm')).toContainText('HOST_A_ONLY signed in')
      await input.pressSequentially('/quit')
      await input.press('Enter')
      await expect(login).toBeHidden()
      await expect(provider.locator('[data-tone]')).toHaveText('Signed in')
    } else {
      await expect(provider).toContainText('phosphor providers login openai-codex')
      info.annotations.push({
        type: 'gap',
        description:
          'Dev Host has no native node-pty resource; provider PTY login unavailable. Real terminal capability was not spoofed.',
      })
    }

    await h.page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
    for (const tab of ['Accounts', 'Agent', 'Extensions', 'Advanced']) {
      await settings.getByRole('button', { name: tab, exact: true }).click()
      await expect(settings).toContainText(
        'These settings configure This Mac, not a remote machine.',
      )
      await expect(settings).toContainText('Remote settings are not available here.')
    }
    await settings.getByRole('button', { name: 'Accounts', exact: true }).click()
    await expect(
      settings.getByRole('button', { name: 'Open bee1 readiness', exact: true }),
    ).toBeVisible()
    await captures(h, info, 'remote-settings-scope')
    expect(errors).toEqual([])
  } finally {
    await h.close()
  }
})

test('A Mac lane notice returns from bee1 and closes the global page', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('queue-hold')
    await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible()
    await openRemote(h)
    await h.page.getByRole('button', { name: 'Routines', exact: true }).click()
    // Finish the held local run through the real bridge while the Host page is shown.
    await h.page.evaluate(async () => {
      const sessions = await window.phosphor.invoke('pi:listLiveSessions')
      const local = sessions.find((session) => session.target?.kind !== 'remote')
      if (!local) throw new Error('Missing local fixture session')
      await window.phosphor.piCommand(local.sessionId, {
        type: 'prompt',
        message: 'Mac background finish',
      })
    })
    const notice = h.page.getByRole('button', { name: /^Open lane:/ })
    await expect(notice).toBeVisible()
    await notice.click()
    await expect(h.page.getByRole('button', { name: 'Machine filter', exact: true })).toContainText(
      'This Mac',
    )
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible()
    await expect(
      h.page.getByTestId('session-row').filter({ hasText: 'LOCAL_ONLY lane' }),
    ).toBeVisible()
  } finally {
    await h.close()
  }
})
