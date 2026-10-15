import { test, expect } from '@playwright/test'
import { remoteHostFixture } from './fixtures/remote-host'
import { openRemote, takeControl, sendTurn, files, file, edit } from './fixtures/remote-ui'

test('Control takeover guards remote mutations and explicit take restores send and save', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await sendTurn(h, 'PHX-controlled')
    await files(h)
    await file(h, 'remote.txt')
    await h.takeover()
    await expect(h.page.getByText('Controlled by Second client', { exact: true })).toBeVisible()
    await expect(h.page.getByRole('status')).toContainText(
      'Read-only. Take control to send messages.',
    )
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveCount(0)
    for (const action of ['New file', 'New folder', 'Save', 'Trash'])
      await expect(h.page.getByRole('button', { name: action, exact: true })).toHaveCount(0)
    await expect(h.page.getByRole('button', { name: 'Attach images', exact: true })).toHaveCount(0)
    await h.page.getByRole('button', { name: /^Terminal pane/ }).click()
    // Baseline remote wrapper refuses Terminal; parity may render a read-only terminal instead.
    await expect(
      h.page.getByText('Not available on remote lanes yet.', { exact: true }),
    ).toBeVisible()
    await expect(h.page.locator('.xterm')).toHaveCount(0)
    await expect(h.page.getByRole('button', { name: 'New terminal', exact: true })).toHaveCount(0)
    // Routines are machine-scoped owner operations, not writes to the viewed lane.
    // Phase 2 adds Desktop Release control. The competing actor uses the real protocol now.
    await h.release()
    await takeControl(h)
    await sendTurn(h, 'PHX-regained')
    await files(h)
    await file(h, 'remote.txt')
    await edit(h, 'HOST_A_ONLY regained save')
    await h.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await h.page.getByRole('button', { name: 'Stop', exact: true }).click()
    await h.page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(h.page.getByTestId('model-chip')).toContainText('HOST_A_ONLY')
    await expect(h.page.locator('main').getByText('PHX-controlled', { exact: true })).toHaveCount(2)
    await sendTurn(h, 'PHX-resumed')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Reconnect, Host restart and Desktop restart retain the original lane', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await sendTurn(h, 'PHX-durable')
    await files(h)
    await file(h, 'remote.txt')
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('slow reconnect response')
    await chat.press('Enter')
    await expect(h.page.locator('main p').filter({ hasText: /^1 2 / })).toBeVisible()
    await chat.fill('draft retained during reconnect')
    const restore = h.severConnection()
    try {
      await expect(h.page.getByText(/Reconnecting|Connecting/).first()).toBeVisible()
    } finally {
      restore()
    }
    await expect(chat).toHaveValue('draft retained during reconnect')
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await expect(h.page.getByText('slow reconnect response', { exact: true })).toHaveCount(1)
    await h.restartHost()
    await h.page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await sendTurn(h, 'recall', 'PHX-durable')
    await h.closeDesktop()
    await h.relaunchDesktop()
    // NO_KEYCHAIN keeps account tokens in memory; authenticate this fresh client.
    await h.signIn()
    // Baseline does not automatically restore remote selection; rediscover explicitly.
    await openRemote(h)
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await sendTurn(h, 'recall', 'PHX-durable')
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('REMOTE_FILE_FROM_REAL_HOST')
    await expect(
      h.page
        .getByRole('region', { name: 'bee1', exact: true })
        .getByRole('button', { name: /Remote test lane/ }),
    ).toHaveCount(1)
  } finally {
    await h.close()
  }
})

test.fixme('Dirty file editor survives connection interruption (phase 2)', async () => {
  // Open remote.txt; edit to HOST_A_ONLY retained dirty without saving; start slow stream.
  // Leave a composer draft; sever socket; assert Reconnecting/waiting; restore socket.
  // Assert draft and dirty text remain in a recreated Monaco editor, no silent save retry.
})

test.fixme('Delete confirms resources and broadcasts removal (phase 2)', async () => {
  // cancel leaves row; controller/refusal remains in confirm for retry. Default
  // transcript/worktree/branch options on isolated lane; delete removes row/open view and peer sees
  // removal; merged branch cleaned, unmerged branch preserved with truthful result. Shared-worktree
  // variant uses session-only options and keeps other lane/files; local lane/sentinel unchanged.
})

test.fixme('Stop before first prompt preserves a recoverable remote lane (phase 2)', async () => {
  // Create a fresh lane without sending; Stop then Resume must work, or Stop must clearly
  // refuse before destroying anything. Send first prompt; assert one user/reply and saved lane.
})
