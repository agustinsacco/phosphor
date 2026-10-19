import { expect, test, type Locator } from '@playwright/test'
import type { remoteHostFixture } from './remote-host'
import { captures } from './remote-ui'

type Host = Awaited<ReturnType<typeof remoteHostFixture>>

export async function addPrivateConnector(h: Host, settings: Locator): Promise<void> {
  await settings.getByRole('button', { name: 'Add connector', exact: true }).click()
  const add = h.page.getByRole('dialog', { name: 'Add connector on bee1', exact: true })
  await add
    .getByRole('combobox', { name: 'Connector catalogue', exact: true })
    .selectOption('custom')
  await add.getByRole('textbox', { name: 'Server name', exact: true }).fill('private-tools')
  await add
    .getByRole('textbox', { name: 'Server URL', exact: true })
    .fill('https://example.invalid/mcp')
  await add.getByLabel('Authorization header', { exact: true }).fill('Bearer HOST_ONLY_MCP_SECRET')
  await add.getByRole('button', { name: 'Review and add', exact: true }).click()
  await h.page.getByRole('button', { name: 'Save on this Host', exact: true }).click()
  await expect(add).toBeHidden()
}

export async function addPrivateAccount(h: Host, settings: Locator, email: string): Promise<void> {
  const add = settings.getByRole('button', { name: 'Add account', exact: true })
  await expect(add).toBeEnabled({ timeout: 30_000 })
  await add.click()
  const login = h.page.getByRole('dialog', { name: 'Provider sign-in on bee1', exact: true })
  await expect(login.locator('.xterm')).toContainText('HOST_A_ONLY Claude account email:')
  if (email === 'work@host.example')
    await captures(h, test.info(), 'machine-settings-private-sign-in')
  const input = login.locator('.xterm-helper-textarea')
  await input.focus()
  await input.pressSequentially(email, { delay: 5 })
  await input.press('Enter')
  await expect(login.locator('.xterm')).toContainText('HOST_A_ONLY Login successful.')
  await expect(login).toContainText('Program exited')
  await login.getByRole('button', { name: 'Done', exact: true }).click()
  const verified = await h.page.evaluate(
    (hostId) => window.phosphor.invoke('hosts:settingsRead', hostId, 'providers'),
    h.hostId,
  )
  await test.info().attach('provider-verification.json', {
    body: JSON.stringify(verified),
    contentType: 'application/json',
  })
  expect(verified.providers?.accounts.map((account) => account.email)).toContain(email)
  await expect(settings.getByRole('heading', { name: email, exact: true })).toBeVisible({
    timeout: 30_000,
  })
}

export async function createBillingLane(h: Host) {
  return await h.page.evaluate(
    async ({ hostId, repo }) => {
      const host = (await window.phosphor.invoke('hosts:snapshot'))[hostId]!
      const repository = host.repositories.find((entry) => entry.path === repo)!
      const lane = await window.phosphor.invoke('hosts:createLane', hostId, {
        repositoryId: repository.id,
        name: 'Billing identity test',
        provider: 'pi-claude-cli',
        model: 'claude-test',
      })
      const reply = await window.phosphor.piCommand(lane.sessionId, {
        type: 'prompt',
        message: 'CLAUDE_BILLING_AFFINITY',
      })
      if (!reply.success) throw new Error('Fixture prompt failed')
      return lane
    },
    { hostId: h.hostId, repo: h.repo },
  )
}

export function billingHistory(h: Host, sessionId: string) {
  return h.page.evaluate(async (id) => {
    const reply = await window.phosphor.piCommand(id, { type: 'get_messages' })
    return reply.success ? JSON.stringify(reply.data) : ''
  }, sessionId)
}

export async function moveBillingAccount(
  h: Host,
  settings: Locator,
  session: Awaited<ReturnType<typeof createBillingLane>>,
  backup: { id: string },
  historyBeforeMove: string,
) {
  await settings.getByRole('button', { name: 'Refresh', exact: true }).click()
  const workRow = settings
    .locator('li')
    .filter({ has: h.page.getByText('work@host.example', { exact: true }) })
  await workRow.getByRole('button', { name: 'Usage & lanes', exact: true }).click()
  await expect(workRow).toContainText('Billing identity test')
  await captures(h, test.info(), 'machine-settings-claude-accounts')
  await workRow.getByRole('button', { name: 'Move to backup@host.example', exact: true }).click()
  await h.page
    .getByRole('button', { name: 'Move to backup@host.example and restart', exact: true })
    .click()
  await expect
    .poll(async () => {
      const result = await h.page.evaluate(
        (hostId) => window.phosphor.invoke('hosts:settingsRead', hostId, 'providers'),
        h.hostId,
      )
      return result.providers?.accounts
        .find((account) => account.id === backup.id)
        ?.lanes.some((lane) => lane.id === session.laneId && lane.active)
    })
    .toBe(true)
  const resumed = await h.page.evaluate(
    async ({ hostId, laneId }) => window.phosphor.invoke('hosts:openLane', hostId, laneId),
    { hostId: h.hostId, laneId: session.laneId! },
  )
  expect(await billingHistory(h, resumed.sessionId)).toBe(historyBeforeMove)
  return resumed
}
