import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { captures, openRemote, selectMachine } from './fixtures/remote-ui'

test('bee1 receipt stays machine scoped while This Mac is selected', async ({
  browserName: _,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await selectMachine(h, 'This Mac')
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await h.backgroundTurn('PHX-receipt-test')
    const card = h.page.getByTestId('toast').filter({ hasText: 'tests pass' })
    await expect(card).toBeVisible()
    await card.hover()
    for (const text of ['bee1', 'Linux', 'repository', '⎇', '1 file', '+1', '-1', 'tests pass'])
      await expect(card).toContainText(text)
    await captures(h, info, 'host-lane-receipt')
    const changes = card.getByRole('button', { name: 'View changes', exact: true })
    await changes.focus()
    await changes.press('Enter')
    await expect(h.page.getByRole('tree', { name: 'Changed files', exact: true })).toBeVisible()
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('PHX-receipt')
    await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible()
    await h.backgroundTurn('fail-turn')
    const attention = h.frames.filter((frame) => frame.type === 'attention').at(-1)
    expect(attention?.event.kind).toBe('failed')
    const stopped = h.page.locator('[data-testid="toast"][data-kind="error"]')
    await expect(stopped).toBeVisible()
    await expect(stopped).toContainText('Stopped: HOSTAONLY provider error')
    await expect(stopped).not.toContainText('tests pass')
    await expect(stopped.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    await stopped.hover()
    await captures(h, info, 'stopped-lane-receipt')
  } finally {
    await h.close()
  }
})

test('This Mac lane shows its own receipt after settling off screen', async ({
  browserName: _,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    execFileSync('git', ['init', '-q', '-b', 'receipt-branch', h.workspace])
    execFileSync('git', [
      '-C',
      h.workspace,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fixture',
    ])
    await h.relaunchDesktop()
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('PHX-receipt')
    await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toBeVisible()
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(h.page.getByPlaceholder('Describe a task or ask a question')).toBeVisible()
    // The stub settles the turn only now, so it always settles off screen.
    writeFileSync(join(h.workspace, '.phx-receipt-go'), '')
    const card = h.page.getByTestId('toast').filter({ hasText: 'tests pass' })
    await expect(card).toBeVisible()
    await card.hover()
    for (const text of [
      'This Mac',
      'workspace',
      // Auto-naming may rename the branch before the card shows; either name is the lane's.
      '⎇ phosphor/',
      '1 file',
      '+1',
      '-1',
      'tests pass',
    ])
      await expect(card).toContainText(text)
    await captures(h, info, 'local-lane-receipt')
    await card.getByRole('button', { name: 'View changes', exact: true }).focus()
    await card.getByRole('button', { name: 'View changes', exact: true }).press('Enter')
    await expect(h.page.getByText('Files changed', { exact: true })).toBeVisible()
    await expect(h.page.getByRole('button', { name: /hello.ts/ }).first()).toBeVisible()
  } finally {
    await h.close()
  }
})
