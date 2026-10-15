import { selectLane } from './fixtures/remote-ui'
import { test, expect } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import {
  openRemote,
  takeControl,
  files,
  file,
  edit,
  pathPrompt,
  captures,
} from './fixtures/remote-ui'

test('Remote file mutations preserve conflicts and isolation', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await files(h)
    // The parity Files rebuild changes toolbar layout, not these visible actions.
    await pathPrompt(h, 'New folder', 'created')
    await pathPrompt(h, 'New file', 'draft.txt')
    await file(h, 'draft.txt')
    await edit(h, 'HOST_A_ONLY saved')
    await h.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect.poll(() => readFile(join(h.repo, 'draft.txt'), 'utf8')).toBe('HOST_A_ONLY saved')
    await pathPrompt(h, 'Rename', 'renamed.txt')
    await file(h, 'renamed.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY saved')
    await pathPrompt(h, 'Copy to folder', 'created')
    await file(h, 'renamed.txt')
    await pathPrompt(h, 'Move to folder', 'nested')
    await file(h, 'created/renamed.txt')
    await pathPrompt(h, 'Trash', 'created/renamed.txt')
    await expect(h.page.getByRole('treeitem', { name: /^renamed\.txt/ })).toHaveCount(0)
    await h.page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await file(h, 'nested/renamed.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY saved')
    await edit(h, 'HOST_A_ONLY dirty conflict')
    await h.conflictWrite('nested/renamed.txt', 'HOST_A_ONLY competing write')
    await h.page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(
      h.page.getByRole('alert').filter({ hasText: 'File changed on disk' }),
    ).toContainText('File changed on disk')
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY dirty conflict')
    expect(await readFile(join(h.repo, 'nested/renamed.txt'), 'utf8')).toBe(
      'HOST_A_ONLY competing write',
    )
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
    await h.page.getByRole('button', { name: 'Discard edits', exact: true }).click()
    await h.page.getByRole('button', { name: /^Changes pane/ }).click()
    await expect(h.page.getByRole('treeitem', { name: /^deleted\.txt/ })).toBeVisible()
    await expect(h.page.getByRole('treeitem', { name: /^untracked\.txt/ })).toBeVisible()
    await file(h, 'staged.txt')
    await expect(h.page.locator('.monaco-diff-editor')).toContainText('before staging')
    await expect(h.page.locator('.monaco-diff-editor')).toContainText('staged change')
  } finally {
    await h.close()
  }
})

test('Files is styled in empty, populated and non-git folders', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await files(h)
    await expect(h.page.getByRole('tree', { name: 'Files', exact: true })).toBeVisible()
    for (const name of ['Refresh', 'New file', 'New folder'])
      await expect(h.page.getByRole('button', { name, exact: true })).toBeVisible()
    await file(h, 'nested/guide.md')
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY guide')
    await captures(h, info, 'remote-files-populated')
    await file(h, 'binary.bin')
    await expect(h.page.getByText('Binary file', { exact: true })).toBeVisible()
    await file(h, 'oversize.txt')
    await expect(h.page.getByText('File too large', { exact: true })).toBeVisible()
    await h.createLane(1)
    await selectLane(h, 'HOST_B_ONLY lane')
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_B_ONLY non-git')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('HOST_A_ONLY')
    await expect(
      h.page.getByRole('status').filter({ hasText: 'Git status is unavailable.' }),
    ).toBeVisible()
    await captures(h, info, 'remote-files-non-git')
    await h.page.getByRole('button', { name: /^Changes pane/ }).click()
    await expect(h.page.getByText('No changes yet', { exact: true })).toBeVisible()
    await captures(h, info, 'remote-files-empty-changes')
  } finally {
    await h.close()
  }
})

test('Chat paths open the correct lane buffer', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('links')
    await chat.press('Enter')
    await h.page.getByRole('link', { name: 'HOST_A_ONLY guide', exact: true }).click()
    await expect(h.page.locator('.monaco-editor')).toContainText('second line')
    await h.page.getByRole('link', { name: 'absolute', exact: true }).click()
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY modified')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('LOCAL_ONLY decoy')
    await h.page.getByRole('link', { name: 'outside', exact: true }).click()
    await expect(h.page.getByText('File is unavailable.', { exact: true })).toBeVisible()
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY modified')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Two worktrees keep the same relative file isolated A→B→A', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.createWorktreePair()
    await h.signIn()
    await openRemote(h, 'HOST_A_ONLY fixture-a')
    await takeControl(h)
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('WORKTREE_A')
    await selectLane(h, 'HOST_A_ONLY fixture-b')
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('WORKTREE_B')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('WORKTREE_A')
    await selectLane(h, 'HOST_A_ONLY fixture-a')
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('WORKTREE_A')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('WORKTREE_B')
  } finally {
    await h.close()
  }
})

test('An uncertain remote save keeps edited content and never silently retries', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await files(h)
    await file(h, 'remote.txt')
    await edit(h, 'HOST_A_ONLY uncertain')
    // Cut the transport at the user action boundary. No renderer state or RPC mocks.
    const restore = h.severConnection()
    try {
      await h.page.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 1000 })
      await expect(
        h.page.getByRole('alert').filter({ hasText: 'Save not confirmed.' }),
      ).toBeVisible()
    } finally {
      restore()
    }
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY uncertain')
    await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('A save cut off after Host admission is reconciled once on reconnect', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await files(h)
    await file(h, 'remote.txt')
    await edit(h, 'HOST_A_ONLY admitted save')
    const lost = h.loseWriteReceipt('remote.txt', 'HOST_A_ONLY admitted save')
    try {
      await h.page.getByRole('button', { name: 'Save', exact: true }).click()
      await lost.landed
      const identity = await stat(join(h.repo, 'remote.txt'), { bigint: true })
      expect(await h.readHostFile('remote.txt')).toBe('HOST_A_ONLY admitted save')
      await expect(h.page.getByRole('button', { name: 'Discard edits', exact: true })).toBeVisible()
      await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      lost.restore()
      await expect(h.page.getByRole('button', { name: 'Discard edits', exact: true })).toHaveCount(
        0,
      )
      await expect(h.page.getByRole('treeitem', { name: /^remote\.txt/ })).toBeEnabled()
      await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      await expect(h.page.getByTestId('right-pane').getByRole('alert')).toHaveCount(0)
      const settled = await stat(join(h.repo, 'remote.txt'), { bigint: true })
      expect([settled.ino, settled.mtimeNs]).toEqual([identity.ino, identity.mtimeNs])
      expect(await h.readHostFile('remote.txt')).toBe('HOST_A_ONLY admitted save')
      expect(new Set(lost.writes().map((frame) => frame.requestId)).size).toBe(1)
      console.log('admitted-save raw files.write frames:', lost.writes().length)
      expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
    } finally {
      lost.restore()
    }
  } finally {
    await h.close()
  }
})

// remote shortcuts: enabled by the parity shortcuts fix
test('Finder opens the correct Host file and line', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    await h.page.getByRole('textbox', { name: 'Chat message', exact: true }).focus()
    await h.page.keyboard.press('ControlOrMeta+KeyP')
    const finder = h.page.getByRole('combobox', { name: 'Go to file', exact: true })
    await finder.fill('guide:2')
    await h.page.getByRole('option').filter({ hasText: 'guide.md' }).click()
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY guide')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('LOCAL_ONLY')
    const activeLine = h.page
      .getByTestId('right-pane')
      .locator('.monaco-editor .line-numbers.active-line-number')
    await expect(activeLine).toHaveText('2')
    const editor = h.page.getByTestId('right-pane').locator('.monaco-editor [role="textbox"]')
    await editor.focus()
    await expect(editor).toBeFocused()
    await expect(activeLine).toHaveText('2')
    await expect(editor).toBeEditable()
    await h.page.keyboard.insertText('FINDER_LINE_2 ')
    await expect(h.page.locator('.monaco-editor .view-lines')).toContainText('FINDER_LINE_2')
    await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
    await h.page.keyboard.press('ControlOrMeta+KeyS')
    await expect
      .poll(async () => (await h.readHostFile('nested/guide.md')).split('\n')[1])
      .toContain('FINDER_LINE_2')
    expect((await h.readHostFile('nested/guide.md')).split('\n')[0]).not.toContain('FINDER_LINE_2')
  } finally {
    await h.close()
  }
})

// parity fix: remote dirty buffers per lane
test('Dirty worktree editor survives A→B→A without leaking into the other lane', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.createWorktreePair()
    await h.signIn()
    await openRemote(h, 'HOST_A_ONLY fixture-a')
    await takeControl(h)
    await files(h)
    await file(h, 'remote.txt')
    await edit(h, 'HOST_A_ONLY dirty worktree A')
    await selectLane(h, 'HOST_A_ONLY fixture-b')
    await files(h)
    await file(h, 'remote.txt')
    await expect(h.page.locator('.monaco-editor')).toContainText('WORKTREE_B')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('dirty worktree A')
    await selectLane(h, 'HOST_A_ONLY fixture-a')
    await files(h)
    await expect(h.page.locator('.monaco-editor')).toContainText('HOST_A_ONLY dirty worktree A')
    await expect(h.page.locator('.monaco-editor')).not.toContainText('WORKTREE_B')
    await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  } finally {
    await h.close()
  }
})

test('An empty Host folder has the styled Files empty state', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.createEmptyLane()
    await h.signIn()
    await openRemote(h, 'HOST_EMPTY lane')
    await takeControl(h)
    await files(h)
    await expect(h.page.getByText('No files yet', { exact: true })).toBeVisible()
    await expect(h.page.getByRole('button', { name: 'New file', exact: true })).toBeEnabled()
    await expect(h.page.locator('.monaco-editor')).toHaveCount(0)
    await captures(h, info, 'remote-files-empty')
  } finally {
    await h.close()
  }
})
