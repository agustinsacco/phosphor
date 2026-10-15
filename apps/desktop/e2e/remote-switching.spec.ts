import { selectLane } from './fixtures/remote-ui'
import { test, expect } from '@playwright/test'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import {
  openRemote,
  takeControl,
  selectMachine,
  files,
  file,
  captures,
  pane,
} from './fixtures/remote-ui'

// parity fix: remote artifacts + tool rows
test('Every lane surface refreshes A→B→A', async ({ browserName: _browserName }, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'This Mac')
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('artifact')
    await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
    const local = h.page.getByTestId('session-row').first()
    await expect(local).toBeVisible()
    await pane(h, 'Artifacts')
    await expect(h.page.getByText('LOCAL_ONLY Card', { exact: true }).first()).toBeVisible()
    await expect(h.page.getByRole('button', { name: /^Artifacts pane/ })).toBeVisible()
    await captures(h, info, 'local-artifacts-pane')
    await openRemote(h)
    await takeControl(h)
    await pane(h, 'Artifacts')
    await expect(h.page.getByText('No artifacts yet', { exact: true })).toBeVisible()
    await expect(h.page.getByText('LOCAL_ONLY Card', { exact: true })).toHaveCount(0)
    await captures(h, info, 'empty-host-artifacts-pane')
    const second = await h.createLane(1)
    expect(second).toBeTruthy()
    for (const [title, marker, previous] of [
      ['Remote test lane', 'HOST_A_ONLY', 'HOST_B_ONLY'],
      ['HOST_B_ONLY lane', 'HOST_B_ONLY', 'HOST_A_ONLY'],
      ['Remote test lane', 'HOST_A_ONLY', 'HOST_B_ONLY'],
    ]) {
      await selectLane(h, title)
      await files(h)
      await file(h, 'remote.txt')
      await expect(h.page.locator('.monaco-editor')).toContainText(marker)
      await expect(h.page.locator('.monaco-editor')).not.toContainText(previous)
      for (const name of ['Terminal', 'Subagents']) {
        await pane(h, name)
        await expect(
          h.page.getByText('Not available on remote lanes yet.', { exact: true }),
        ).toBeVisible()
        await expect(h.page.locator('.monaco-editor')).toHaveCount(0)
      }
      await pane(h, 'Artifacts')
      await expect(h.page.getByText('No artifacts yet', { exact: true })).toBeVisible()
    }
    await selectMachine(h, 'This Mac')
    await local.click()
    await pane(h, 'Artifacts')
    await expect(h.page.getByText('LOCAL_ONLY Card', { exact: true }).first()).toBeVisible()
    await expect(h.page.getByTestId('model-chip')).toContainText('LOCAL_ONLY Model')
    await expect(h.page.getByTestId('model-chip')).not.toContainText('HOST_')
  } finally {
    await h.close()
  }
})

test('Switcher drives pages; page override resets and never revives Mac data', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    for (const [page, host, local] of [
      ['Skills', 'HOST_A_ONLY', 'LOCAL_ONLY'],
      ['Routines', 'HOST_A_ONLY routine', 'LOCAL_ONLY routine'],
    ]) {
      await selectMachine(h, 'bee1')
      await h.page.getByRole('button', { name: page, exact: true }).first().click()
      await expect(h.page.getByTestId('global-page')).toContainText(host)
      await expect(h.page.getByTestId('global-page')).not.toContainText(local)
      await h.page
        .getByTestId('global-page')
        .getByRole('button', {
          name: page === 'Routines' ? 'Machine filter' : 'Machine',
          exact: true,
        })
        .click()
      await h.page.getByRole('option', { name: 'This Mac', exact: true }).click()
      await expect(h.page.getByTestId('global-page')).toContainText(local)
      await expect(h.page.getByTestId('global-page')).not.toContainText(host)
      await selectMachine(h, 'This Mac')
      await expect(h.page.getByTestId('global-page')).toContainText(local)
      await expect(h.page.getByTestId('global-page')).not.toContainText(host)
      await selectMachine(h, 'bee1')
      await expect(h.page.getByTestId('global-page')).toContainText(host)
      await expect(h.page.getByTestId('global-page')).not.toContainText(local)
    }
    await selectMachine(h, 'All machines')
    await expect(h.page.getByTestId('global-page')).toContainText('LOCAL_ONLY routine')
    await expect(h.page.getByTestId('global-page')).not.toContainText('HOST_A_ONLY routine')
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'Artifacts', exact: true }).first().click()
    await expect(
      h.page.getByTestId('global-page').getByRole('button', { name: 'Machine', exact: true }),
    ).toContainText('bee1')
    await h.page
      .getByTestId('global-page')
      .getByRole('button', { name: 'Machine', exact: true })
      .click()
    await h.page.getByRole('option', { name: 'This Mac', exact: true }).click()
    await expect(
      h.page.getByTestId('global-page').getByRole('button', { name: 'Machine', exact: true }),
    ).toContainText('This Mac')
    await selectMachine(h, 'All machines')
    await expect(
      h.page.getByTestId('global-page').getByRole('button', { name: 'Machine', exact: true }),
    ).toContainText('All machines')
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(h.page.getByRole('region', { name: 'Host home', exact: true })).toContainText(
      'Remote test lane',
    )
    await expect(h.page.getByRole('region', { name: 'Host home', exact: true })).not.toContainText(
      'LOCAL_ONLY',
    )
  } finally {
    await h.close()
  }
})

test('Remote Files, Changes, controls, model and error surfaces refresh A→B→A', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.createLane(1)
    await h.signIn()
    await openRemote(h, 'HOST_B_ONLY lane')
    await takeControl(h)
    await h.page.getByTestId('model-chip').click()
    await h.page.getByTestId('model-search').fill('HOST_B_ONLY')
    await h.page.getByTestId('model-row').filter({ hasText: 'HOST_B_ONLY' }).click()
    await expect(h.page.getByTestId('model-chip')).toContainText('HOST_B_ONLY Reasoner')
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('fail-turn')
    await chat.press('Enter')
    await expect(h.page.getByText('HOST_A_ONLY provider error', { exact: false })).toBeVisible()
    for (const [title, marker, previous] of [
      ['Remote test lane', 'HOST_A_ONLY', 'HOST_B_ONLY'],
      ['HOST_B_ONLY lane', 'HOST_B_ONLY', 'HOST_A_ONLY'],
      ['Remote test lane', 'HOST_A_ONLY', 'HOST_B_ONLY'],
    ]) {
      await selectLane(h, title)
      await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
      await files(h)
      await file(h, 'remote.txt')
      await expect(h.page.locator('.monaco-editor')).toContainText(marker)
      await expect(h.page.locator('.monaco-editor')).not.toContainText(previous)
      await pane(h, 'Changes')
      if (title === 'HOST_B_ONLY lane') {
        await expect(h.page.getByText('No changes yet', { exact: true })).toBeVisible()
        await expect(h.page.getByRole('treeitem', { name: /^deleted\.txt/ })).toHaveCount(0)
        await expect(h.page.getByText('HOST_A_ONLY provider error', { exact: false })).toHaveCount(
          0,
        )
      } else {
        await expect(h.page.getByRole('treeitem', { name: /^deleted\.txt/ })).toBeVisible()
        await expect(h.page.getByText('HOST_A_ONLY provider error', { exact: false })).toBeVisible()
      }
      for (const name of ['Terminal', 'Subagents']) {
        await pane(h, name)
        await expect(
          h.page.getByText('Not available on remote lanes yet.', { exact: true }),
        ).toBeVisible()
        await expect(h.page.locator('.monaco-editor')).toHaveCount(0)
      }
      const ownModel = title === 'HOST_B_ONLY lane' ? 'HOST_B_ONLY Reasoner' : 'HOST_A_ONLY Fast'
      const previousModel =
        title === 'HOST_B_ONLY lane' ? 'HOST_A_ONLY Fast' : 'HOST_B_ONLY Reasoner'
      await expect(h.page.getByTestId('model-chip')).toContainText(ownModel)
      await expect(h.page.getByTestId('model-chip')).not.toContainText(previousModel)
      await expect(h.page.getByTestId('model-chip')).not.toContainText('Stub')
      await expect(chat).toBeVisible()
    }
  } finally {
    await h.close()
  }
})
