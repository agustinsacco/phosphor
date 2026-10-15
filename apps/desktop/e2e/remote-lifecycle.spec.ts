import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteHostFixture } from './fixtures/remote-host'
import { openRemote, takeControl, sendTurn, files, file, edit } from './fixtures/remote-ui'

test('Control takeover guards remote mutations and explicit take restores send and save', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await h.page.getByRole('button', { name: 'Release control', exact: true }).click()
    await expect(h.page.getByText('No controller', { exact: true })).toBeVisible()
    await takeControl(h)
    await sendTurn(h, 'PHX-controlled')
    await files(h)
    await file(h, 'remote.txt')
    await h.takeover()
    await expect(h.page.getByText('Controlled by Second client', { exact: true })).toBeVisible()
    await expect(h.page.getByRole('status').filter({ hasText: 'Read-only.' })).toContainText(
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
    await h.release()
    await takeControl(h)
    await sendTurn(h, 'PHX-regained')
    await files(h)
    await file(h, 'remote.txt')
    await edit(h, 'HOST_A_ONLY regained save')
    await h.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => h.readHostFile('remote.txt')).toBe('HOST_A_ONLY regained save')
    await file(h, 'nested/guide.md')
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor .view-lines')).toContainText(
      'HOST_A_ONLY regained save',
    )
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
    await chat.fill(h.slowTurn.prompt)
    await chat.press('Enter')
    const streamed = h.page.locator('main p').filter({ hasText: /^1 2 / })
    await expect(streamed).toBeVisible()
    await chat.fill('draft retained during reconnect')
    const restore = h.severConnection()
    try {
      await expect(h.page.getByText(/Reconnecting|Connecting/).first()).toBeVisible()
    } finally {
      restore()
    }
    await expect(chat).toHaveValue('draft retained during reconnect')
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    const recovered = (await streamed.innerText()).trim()
    await expect
      .poll(async () => (await streamed.innerText()).trim().length, { timeout: 2000 })
      .toBeGreaterThan(recovered.length)
    await expect(h.page.locator('button[aria-label="Stop"]')).toBeVisible()
    await h.slowTurn.release()
    await expect(h.page.locator('button[aria-label="Stop"]')).toBeHidden()
    await expect(h.page.locator('main').getByText(h.slowTurn.prompt, { exact: true })).toHaveCount(
      1,
    )
    await expect(streamed).toHaveCount(1)
    const completed = (await streamed.innerText()).trim().split(/\s+/).map(Number)
    expect(completed).toEqual(Array.from({ length: completed.length }, (_, index) => index + 1))
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

test('Dirty file editor survives connection interruption', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await files(h)
    await file(h, 'remote.txt')
    await edit(h, 'HOST_A_ONLY retained dirty')
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill(h.slowTurn.prompt)
    await chat.press('Enter')
    await expect(h.page.locator('main p').filter({ hasText: /^1 2 / })).toBeVisible()
    await chat.fill('HOST_A_ONLY draft')
    const restore = h.severConnection()
    try {
      await expect(
        h.page.getByRole('status').filter({ hasText: 'Unsaved edits are kept' }),
      ).toBeVisible()
      await expect(h.page.locator('.monaco-editor .view-lines')).toContainText(
        'HOST_A_ONLY retained dirty',
      )
    } finally {
      restore()
    }
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await expect(chat).toHaveValue('HOST_A_ONLY draft')
    await expect(h.page.locator('.monaco-editor .view-lines')).toContainText(
      'HOST_A_ONLY retained dirty',
    )
    await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    expect(await h.readHostFile('remote.txt')).toContain('modified')
    await h.slowTurn.release()
  } finally {
    await h.close()
  }
})

test('Delete confirms resources and broadcasts removal', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const shared = await h.createLane(0, undefined, 'HOST_A_ONLY shared')
    await sendTurn(h, 'PHX-delete')
    const row = h.page
      .getByRole('region', { name: 'bee1', exact: true })
      .getByRole('button', { name: /Remote test lane/ })
    await row.click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    const dialog = h.page.locator('[data-modal-overlay]')
    await expect(dialog).toContainText('Delete session?')
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await dialog.getByRole('button', { name: 'Delete session', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect.poll(() => h.laneSummary(h.laneId)).toBeUndefined()
    await expect(
      h.page
        .getByRole('region', { name: 'bee1', exact: true })
        .getByRole('button', { name: /HOST_A_ONLY shared/ }),
    ).toBeVisible()
    expect(h.laneSummary(shared)).toBeTruthy()
    expect(await h.readHostFile('remote.txt')).toContain('HOST_A_ONLY')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Stop before first prompt preserves a recoverable remote lane', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.createLane(0, undefined, '')
    await h.signIn()
    await openRemote(h, 'Untitled lane')
    await takeControl(h)
    const stop = h.page.getByRole('button', { name: 'Stop', exact: true })
    await expect(stop).toBeDisabled()
    await expect(stop).toHaveAttribute(
      'data-tooltip',
      'Send a first message before stopping this lane.',
    )
    await sendTurn(h, 'PHX-first')
    await expect(stop).toBeEnabled()
    await stop.click()
    await h.page.getByRole('button', { name: 'Resume', exact: true }).click()
    await expect(stop).toBeEnabled()
    await sendTurn(h, 'PHX-afterfirstresume')
  } finally {
    await h.close()
  }
})

test('Isolated lane delete defaults remove the worktree but preserve an unmerged branch truthfully', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    const lane = await h.createLane(0, 'unmerged-delete')
    await expect.poll(() => h.laneSummary(lane)?.cwd).toBeTruthy()
    const cwd = h.laneSummary(lane)!.cwd!
    await writeFile(join(cwd, 'unmerged.txt'), 'HOST_A_ONLY unmerged')
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
    git('add', 'unmerged.txt')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-qm',
      'unmerged',
    )
    await h.signIn()
    await openRemote(h, 'HOST_A_ONLY unmerged-delete')
    await takeControl(h)
    const row = h.page
      .getByRole('region', { name: 'bee1', exact: true })
      .getByRole('button', { name: /HOST_A_ONLY unmerged-delete/ })
    await row.click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    const modal = h.page.locator('[data-modal-overlay]')
    await expect(modal).toContainText('All three are on by default.')
    await expect(modal.getByRole('checkbox', { name: /Remove the git worktree/ })).toBeChecked()
    await expect(modal.getByRole('checkbox', { name: /Also delete the branch/ })).toBeChecked()
    await modal.getByRole('button', { name: 'Delete lane', exact: true }).click()
    await expect(row).toHaveCount(0)
    await expect(
      h.page.getByText("Branch kept: it isn't merged yet.", { exact: true }),
    ).toBeVisible()
    await expect.poll(() => h.laneSummary(lane)).toBeUndefined()
    await expect(stat(cwd)).rejects.toThrow()
    expect(
      execFileSync('git', ['-C', h.repo, 'branch', '--list', 'unmerged-delete'], {
        encoding: 'utf8',
      }),
    ).toContain('unmerged-delete')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})
