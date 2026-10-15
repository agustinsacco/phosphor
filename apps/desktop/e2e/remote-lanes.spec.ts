import { test, expect } from '@playwright/test'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import {
  selectMachine,
  remoteRow,
  sendTurn,
  captures,
  openRemote,
  takeControl,
} from './fixtures/remote-ui'

test('Create on bee1 with a usable default and name the first turn', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'New lane in repository', exact: true }).click()
    const dialog = h.page
      .locator('form')
      .filter({ has: h.page.getByRole('button', { name: 'Create lane', exact: true }) })
    await expect(h.page.getByText('New lane on bee1', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Model', exact: true })).toContainText(
      'HOST_B_ONLY Reasoner',
    )
    await expect(dialog).not.toContainText('LOCAL_ONLY')
    await expect(dialog.getByRole('button', { name: 'Repository', exact: true })).toContainText(
      'repository',
    )
    await captures(h, info, 'new-remote-lane')
    await dialog.getByRole('button', { name: 'Create lane', exact: true }).click()
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await sendTurn(h, 'PHX-created')
    await expect(remoteRow(h, 'HOST_A_ONLY title')).toBeVisible()
    await expect(h.page.locator('aside')).not.toContainText('Untitled lane')
    await remoteRow(h, 'HOST_A_ONLY title').click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Rename', exact: true })
      .click()
    await h.page.getByRole('textbox', { name: 'Lane name', exact: true }).fill('HOST_A_ONLY manual')
    await captures(h, info, 'remote-inline-rename')
    await h.page.getByRole('textbox', { name: 'Lane name', exact: true }).press('Enter')
    await sendTurn(h, 'PHX-afterrename')
    await expect(remoteRow(h, 'HOST_A_ONLY manual')).toBeVisible()
    await captures(h, info, 'remote-header')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Home composer sends only after controlled remote creation', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await expect(h.page.getByRole('button', { name: 'Model', exact: true })).toContainText(
      'HOST_B_ONLY Reasoner',
    )
    await h.page.getByRole('button', { name: 'Repository', exact: true }).click()
    await h.page.getByRole('option', { name: 'notes', exact: true }).click()
    await h.page.getByRole('button', { name: 'Thinking', exact: true }).click()
    await h.page.getByRole('option', { name: 'high', exact: true }).click()
    const draft = h.page.getByPlaceholder('Describe a task or ask a question')
    await draft.fill('PHX-home')
    const restore = h.severConnection()
    try {
      await expect(h.page.getByRole('region', { name: 'Host home', exact: true })).toContainText(
        'Reconnecting',
      )
      await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
      await expect(draft).toHaveValue('PHX-home')
      await expect(h.page.getByTestId('session-row')).toHaveCount(0)
      await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue(
        'PHX-home',
      )
    } finally {
      restore()
    }
    await expect(h.page.getByRole('button', { name: 'Model', exact: true })).toContainText(
      'HOST_B_ONLY Reasoner',
    )

    await h.page.getByRole('button', { name: 'Start session', exact: true }).click()
    await expect(h.page.locator('main').getByText('PHX-home', { exact: true })).toHaveCount(2)
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('')
    await expect(h.page.getByTestId('session-row')).toHaveCount(0)
    await expect(h.page.getByTestId('model-chip')).toContainText('HOST_B_ONLY Reasoner')
    await expect(h.page.getByTestId('thinking-chip')).toContainText('High')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Remote row menu is complete, gated and durable', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const row = remoteRow(h)
    await row.click({ button: 'right' })
    for (const name of [
      'Open',
      'Rename',
      'Release control',
      'Stop',
      'Mark read',
      'Pin',
      'Lane marker',
      'Copy debug info',
      'Copy spend',
      'Delete',
    ])
      await expect(
        h.page.getByTestId('context-menu').getByRole('button', { name, exact: true }),
      ).toBeVisible()
    for (const name of ['Session tree', 'Fork', 'Clone', 'Make routine'])
      await expect(
        h.page.getByTestId('context-menu').getByRole('button', { name, exact: true }),
      ).toHaveCount(0)
    await captures(h, info, 'remote-row-menu')
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Pin', exact: true })
      .click()
    await row.focus()
    await row.press('Shift+F10')
    await expect(
      h.page.getByTestId('context-menu').getByRole('button', { name: 'Unpin', exact: true }),
    ).toBeVisible()
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Copy debug info', exact: true })
      .click()
    await expect
      .poll(() => h.app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('bee1')
    const clipboard = await h.app.evaluate(({ clipboard }) => clipboard.readText())
    expect(clipboard).toContain('bee1')
    expect(clipboard).not.toContain(h.root)
    await row.press('Shift+F10')
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Lane marker', exact: true })
      .click()
    const picker = h.page.getByRole('dialog', { name: 'Lane marker', exact: true })
    await picker.getByRole('textbox', { name: 'Search icons', exact: true }).fill('rocket')
    await picker.getByRole('button', { name: 'rocket', exact: true }).click()
    await expect(row.getByTestId('lane-marker')).toContainText('🚀')
    await captures(h, info, 'remote-row-marker')

    await row.click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Rename', exact: true })
      .click()
    await h.page
      .getByRole('textbox', { name: 'Lane name', exact: true })
      .fill('HOST_A_ONLY renamed')
    await h.page.getByRole('textbox', { name: 'Lane name', exact: true }).press('Enter')
    await expect(remoteRow(h, 'HOST_A_ONLY renamed')).toBeVisible()
    await h.closeDesktop()
    await h.relaunchDesktop()
    await h.signIn()
    await openRemote(h, 'HOST_A_ONLY renamed')
    await expect(remoteRow(h, 'HOST_A_ONLY renamed').getByTestId('lane-marker')).toContainText('🚀')
    await remoteRow(h, 'HOST_A_ONLY renamed').press('Shift+F10')
    await expect(
      h.page.getByTestId('context-menu').getByRole('button', { name: 'Unpin', exact: true }),
    ).toBeVisible()
  } finally {
    await h.close()
  }
})

test('A manual Host name wins while first-prompt auto-naming is pending', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'New lane in repository', exact: true }).click()
    await h.page.getByRole('button', { name: 'Create lane', exact: true }).click()
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await sendTurn(h, h.slowName.prompt, 'PHX-delayedname')
    const row = remoteRow(h, 'PHX-delayedname')
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Rename', exact: true })
      .click()
    await h.page
      .getByRole('textbox', { name: 'Lane name', exact: true })
      .fill('HOST_A_ONLY user wins')
    await h.page.getByRole('textbox', { name: 'Lane name', exact: true }).press('Enter')
    await h.slowName.release()
    await expect.poll(h.slowName.finished).toBe(true)
    await sendTurn(h, 'PHX-manualwins')
    await expect(remoteRow(h, 'HOST_A_ONLY user wins')).toBeVisible()
    await expect(remoteRow(h, 'HOST_A_ONLY title')).toHaveCount(0)
  } finally {
    await h.close()
  }
})
