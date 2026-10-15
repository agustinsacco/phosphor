import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteHostFixture } from './fixtures/remote-host'
import { openRemote, takeControl, files, file, edit, pathPrompt } from './fixtures/remote-ui'

test('Remote file mutations preserve conflicts and isolation', async () => {
  test.setTimeout(25_000)
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
    await expect(h.page.getByRole('button', { name: /created\/renamed\.txt$/ })).toHaveCount(0)
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
    await expect(h.page.getByRole('button', { name: /deleted\.txt$/ })).toBeVisible()
    await expect(h.page.getByRole('button', { name: /untracked\.txt$/ })).toBeVisible()
    await file(h, 'staged.txt')
    await expect(h.page.locator('.monaco-diff-editor')).toContainText('before staging')
    await expect(h.page.locator('.monaco-diff-editor')).toContainText('staged change')
  } finally {
    await h.close()
  }
})

test.fixme('Files is styled in empty, populated and non-git folders (phase 2)', async () => {
  // open tree, nested text, binary/large placeholder; assert labelled toolbar/empty state/readable
  // content in both themes. Browse non-git folder and assert file appears even with Git
  // unavailable; Files still usable.
})

test.fixme('Finder and chat paths open the correct lane buffer (phase 2)', async () => {
  // use finder, relative link+line and mapped absolute tool link; assert selected remote
  // filename/content and line. Outside-root link shows refusal. Open same relative file in two
  // same-repo worktrees with different markers; A→B→A retains correct contents and dirty buffer.
})

test.fixme('An uncertain remote save keeps edited content and never silently retries (phase 2)', async () => {
  // Open a Host file, edit without saving, sever the save receipt after admission.
  // Assert an explicit unconfirmed outcome and retained dirty text, not automatic retry.
  // Reconnect and reconcile disk content explicitly; local sentinel remains unchanged.
})
