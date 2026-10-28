import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import {
  selectMachine,
  remoteRow,
  sendTurn,
  captures,
  openRemote,
  takeControl,
  sidebarHost,
} from './fixtures/remote-ui'

test('Create on bee1 with a usable default and name the first turn', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    execFileSync('git', ['branch', 'phosphor/phx-created'], { cwd: h.repo })
    const base = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: h.repo,
      encoding: 'utf8',
    }).trim()
    await h.signIn()
    await selectMachine(h, 'bee1')
    await sidebarHost(h)
      .getByRole('button', { name: 'New lane in repository', exact: true })
      .click()
    await expect(h.page.getByRole('button', { name: 'Machine', exact: true })).toContainText('bee1')
    await expect(h.page.getByTestId('remote-model-picker')).toContainText('HOST_B_ONLY Reasoner')
    await expect(h.page.getByRole('button', { name: 'Repository', exact: true })).toContainText(
      'repository',
    )
    await captures(h, info, 'host-home-composer')
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('PHX-created')
    await h.page.getByRole('button', { name: 'Start lane', exact: true }).click()
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const hosts = await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot'))
        return Object.values(hosts)
          .flatMap((host) => host.lanes)
          .some((lane) => lane.branch === 'phosphor/phx-created-2' && lane.worktree)
      })
      .toBe(true)
    expect(
      execFileSync('git', ['rev-parse', 'phosphor/phx-created-2'], {
        cwd: h.repo,
        encoding: 'utf8',
      }).trim(),
    ).toBe(base)
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
    await h.page.getByTestId('thinking-chip').click()
    const low = h.page.getByRole('button', { name: 'Low', exact: true })
    await low.focus()
    await low.press('Enter')
    await expect(h.page.getByTestId('thinking-chip')).toContainText('Low')
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await expect(h.page.getByTestId('remote-model-picker')).toContainText('HOST_B_ONLY Reasoner')
    await expect(h.page.getByTestId('remote-thinking-picker')).toContainText('Low')
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
    await expect(h.page.getByTestId('remote-model-picker')).toContainText('HOST_B_ONLY Reasoner')
    await h.page.getByRole('button', { name: 'Repository', exact: true }).click()
    await h.page.getByRole('option', { name: 'notes', exact: true }).click()
    await h.page.getByTestId('remote-thinking-picker').click()
    await h.page.getByRole('button', { name: 'High', exact: true }).click()
    await h.page.getByRole('checkbox').uncheck()
    const draft = h.page.getByPlaceholder('Describe a task or ask a question')
    await draft.fill('PHX-home')
    const restore = h.severConnection()
    try {
      await expect(h.page.getByRole('region', { name: 'Host home', exact: true })).toContainText(
        'Reconnecting',
      )
      await expect(h.page.getByRole('button', { name: 'Start lane', exact: true })).toBeDisabled()
      await draft.press('Enter')
      await expect(draft).toHaveValue('PHX-home')
      await expect(h.page.getByTestId('session-row')).toHaveCount(0)
      await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue(
        'PHX-home',
      )
    } finally {
      restore()
    }
    await expect(h.page.getByTestId('remote-model-picker')).toContainText('HOST_B_ONLY Reasoner')

    await h.page.getByRole('button', { name: 'Start lane', exact: true }).click()
    await expect(h.page.locator('main').getByText('PHX-home', { exact: true })).toHaveCount(2)
    await expect(h.page.getByRole('textbox', { name: 'Chat message', exact: true })).toHaveValue('')
    await expect(h.page.getByTestId('session-row')).toHaveCount(0)
    await expect(h.page.getByTestId('model-chip')).toContainText('HOST_B_ONLY Reasoner')
    await expect(h.page.getByTestId('thinking-chip')).toContainText('High')
    await expect
      .poll(async () => {
        const hosts = await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot'))
        return Object.values(hosts)
          .flatMap((host) => host.lanes)
          .some((lane) => lane.repositoryId && !lane.worktree && lane.title !== 'Remote test lane')
      })
      .toBe(true)
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Remote row menu is complete, gated and durable @system-clipboard', async ({
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
      /^Stop/, // Until the lane's first message, Stop's name carries why it waits.
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
    await sidebarHost(h)
      .getByRole('button', { name: 'New lane in repository', exact: true })
      .click()
    await expect(h.page.getByTestId('remote-model-picker')).toContainText('HOST_B_ONLY Reasoner')
    await h.page.getByPlaceholder('Describe a task or ask a question').fill(h.slowName.prompt)
    await h.page.getByRole('button', { name: 'Start lane', exact: true }).click()
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
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
