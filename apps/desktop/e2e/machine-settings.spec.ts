import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { captures, openMachineSettings } from './fixtures/remote-ui'
import {
  addPrivateConnector,
  addPrivateAccount,
  createBillingLane,
  billingHistory,
  moveBillingAccount,
} from './fixtures/machine-settings-flow'

test('machine settings save only on bee1, preserve revisions and never read back connector secrets', async () => {
  test.setTimeout(Math.max(REMOTE_TEST_TIMEOUT, 90_000))
  const h = await remoteHostFixture({ allowRepositoryChanges: true })
  try {
    await h.signIn()
    const localBefore = await h.page.evaluate(() => window.phosphor.invoke('pi:agentSettings'))
    const settings = await openMachineSettings(h, 'Agent defaults')
    const before = (await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[
      h.hostId
    ]!
    expect(before.connectionToken).toBeTruthy()
    const budget = settings.getByRole('textbox', { name: 'Host context budget', exact: true })
    await budget.fill('100k')
    await budget.press('Enter')
    await expect
      .poll(async () => JSON.parse(await readFile(h.config, 'utf8')).contextBudget)
      .toBe('100k')
    await expect(h.page.getByTestId('toast-stack')).toContainText(
      'Saved on bee1 — applies to new lanes',
    )
    await expect(budget).toBeEnabled()
    const after = (await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[h.hostId]!
    expect(after.state).toBe('ready')
    expect(after.connectionToken).toBe(before.connectionToken)
    await captures(h, test.info(), 'machine-settings-agent')

    await settings
      .getByRole('navigation', { name: 'Machine settings', exact: true })
      .getByRole('button', { name: 'Connectors', exact: true })
      .click()
    await addPrivateConnector(h, settings)
    await expect(settings.locator('[data-connector="private-tools"]')).toContainText('Not verified')
    const globalMcp = JSON.parse(await readFile(join(h.agent, 'mcp.json'), 'utf8'))
    expect(globalMcp.mcpServers['private-tools'].headers.Authorization).toBe(
      'Bearer HOST_ONLY_MCP_SECRET',
    )
    const metadata = await h.page.evaluate(
      (hostId) => window.phosphor.invoke('hosts:settingsRead', hostId, 'connectors'),
      h.hostId,
    )
    expect(JSON.stringify(metadata)).not.toContain('HOST_ONLY_MCP_SECRET')
    expect(
      JSON.stringify(await h.page.evaluate(() => window.phosphor.invoke('hosts:traffic', 0))),
    ).not.toContain('HOST_ONLY_MCP_SECRET')

    const repository = after.repositories.find((repo) => repo.path === h.repo)!
    await settings
      .getByRole('combobox', { name: 'Host configuration scope', exact: true })
      .selectOption(repository.id)
    await expect(settings).toContainText('This folder is not trusted')
    await settings.getByRole('button', { name: 'Disable in this folder', exact: true }).click()
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(h.repo, '.pi', 'mcp.json'), 'utf8').catch(() => '{}'))
            .mcpServers?.['private-tools']?.enabled,
      )
      .toBe(false)
    await expect(settings).toContainText('Saved but inactive folder entries include: private-tools')
    expect(
      JSON.parse(await readFile(join(h.agent, 'mcp.json'), 'utf8')).mcpServers['private-tools']
        .enabled,
    ).toBeUndefined()
    expect(await h.page.evaluate(() => window.phosphor.invoke('pi:agentSettings'))).toEqual(
      localBefore,
    )
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
    await captures(h, test.info(), 'machine-settings-folder-overrides')
  } finally {
    await h.close()
  }
})

test('private Claude accounts route new Host lanes and an explicit account move preserves resume billing', async () => {
  test.setTimeout(Math.max(REMOTE_TEST_TIMEOUT, 180_000))
  const h = await remoteHostFixture({ claude: true, native: true })
  try {
    await h.installClaudeProvider()
    await h.signIn()
    const settings = await openMachineSettings(h)
    await expect(settings).toContainText('first@host.example')
    expect(
      (await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[h.hostId]
        ?.capabilities,
    ).toContain('terminal')
    await addPrivateAccount(h, settings, 'work@host.example')
    await addPrivateAccount(h, settings, 'backup@host.example')
    // Removing the CLI default proves doctor and startup really honor private accounts.
    const first = settings
      .locator('li')
      .filter({ has: h.page.getByText('first@host.example', { exact: true }) })
    await first.getByRole('button', { name: 'Remove account', exact: true }).click()
    await h.page.getByRole('button', { name: 'Sign out and remove', exact: true }).click()
    await expect(
      settings.getByRole('heading', { name: 'first@host.example', exact: true }),
    ).toBeHidden()
    await settings
      .getByRole('combobox', { name: 'Claude account routing', exact: true })
      .selectOption('specific')
    const accounts = await h.page.evaluate(
      (hostId) => window.phosphor.invoke('hosts:settingsRead', hostId, 'providers'),
      h.hostId,
    )
    const work = accounts.providers!.accounts.find(
      (account) => account.email === 'work@host.example',
    )!
    const backup = accounts.providers!.accounts.find(
      (account) => account.email === 'backup@host.example',
    )!
    await settings
      .getByRole('combobox', { name: 'Pinned Claude account', exact: true })
      .selectOption(work.id)
    await expect(
      settings.getByRole('combobox', { name: 'Pinned Claude account', exact: true }),
    ).toBeEnabled()
    const session = await createBillingLane(h)
    await expect
      .poll(() => billingHistory(h, session.sessionId))
      .toContain('HOST_A_ONLY billing work@host.example')
    const historyBeforeMove = await billingHistory(h, session.sessionId)
    const resumed = await moveBillingAccount(h, settings, session, backup, historyBeforeMove)
    await h.page.evaluate(async (id) => {
      const reply = await window.phosphor.piCommand(id, {
        type: 'prompt',
        message: 'CLAUDE_BILLING_AFFINITY',
      })
      if (!reply.success) throw new Error('Fixture resumed prompt failed')
    }, resumed.sessionId)
    await expect
      .poll(() => billingHistory(h, resumed.sessionId))
      .toContain('HOST_A_ONLY billing backup@host.example')
    const persisted = JSON.parse(
      await readFile(join(h.root, 'state/phosphor-host/claude-accounts/accounts.json'), 'utf8'),
    )
    expect(persisted.pinnedId).toBe(work.id)
    expect(Object.values(persisted.bindings)).toContain(backup.id)
    expect(
      JSON.stringify(
        await h.page.evaluate(
          (hostId) => window.phosphor.invoke('hosts:settingsRead', hostId, 'providers'),
          h.hostId,
        ),
      ),
    ).not.toContain('HOST_ONLY_PRIVATE_CLAUDE_TOKEN')
    expect(
      JSON.stringify(await h.page.evaluate(() => window.phosphor.invoke('hosts:traffic', 0))),
    ).not.toContain('HOST_ONLY_PRIVATE_CLAUDE_TOKEN')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})
