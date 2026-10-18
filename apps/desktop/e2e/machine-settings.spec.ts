import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { captures, openMachineSettings } from './fixtures/remote-ui'

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
    await settings.getByRole('textbox', { name: 'Host context budget', exact: true }).fill('100k')
    await settings.getByRole('button', { name: 'Review Host policy', exact: true }).click()
    await h.page.getByRole('button', { name: 'Save policy', exact: true }).click()
    await expect
      .poll(async () => JSON.parse(await readFile(h.config, 'utf8')).contextBudget)
      .toBe('100k')
    await expect(
      settings.getByRole('button', { name: 'Review Host policy', exact: true }),
    ).toBeEnabled()
    const after = (await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[h.hostId]!
    expect(after.state).toBe('ready')
    expect(after.connectionToken).toBe(before.connectionToken)
    await captures(h, test.info(), 'machine-settings-agent')

    await settings
      .getByRole('navigation', { name: 'Machine settings', exact: true })
      .getByRole('button', { name: 'Connectors', exact: true })
      .click()
    await settings.getByRole('button', { name: 'Add connector', exact: true }).click()
    const add = h.page.getByRole('dialog', { name: 'Add connector on bee1', exact: true })
    await add
      .getByRole('combobox', { name: 'Connector catalogue', exact: true })
      .selectOption('custom')
    await add.getByRole('textbox', { name: 'Server name', exact: true }).fill('private-tools')
    await add
      .getByRole('textbox', { name: 'Server URL', exact: true })
      .fill('https://example.invalid/mcp')
    await add
      .getByLabel('Authorization header', { exact: true })
      .fill('Bearer HOST_ONLY_MCP_SECRET')
    await add.getByRole('button', { name: 'Review and add', exact: true }).click()
    await h.page.getByRole('button', { name: 'Save on this Host', exact: true }).click()
    await expect(add).toBeHidden()
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
    async function addAccount(email: string) {
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
    await addAccount('work@host.example')
    await addAccount('backup@host.example')
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
    const session = await h.page.evaluate(
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
    const history = (sessionId: string) =>
      h.page.evaluate(async (id) => {
        const reply = await window.phosphor.piCommand(id, { type: 'get_messages' })
        return reply.success ? JSON.stringify(reply.data) : ''
      }, sessionId)
    await expect
      .poll(() => history(session.sessionId))
      .toContain('HOST_A_ONLY billing work@host.example')
    const historyBeforeMove = await history(session.sessionId)
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
    expect(await history(resumed.sessionId)).toBe(historyBeforeMove)
    await h.page.evaluate(async (id) => {
      const reply = await window.phosphor.piCommand(id, {
        type: 'prompt',
        message: 'CLAUDE_BILLING_AFFINITY',
      })
      if (!reply.success) throw new Error('Fixture resumed prompt failed')
    }, resumed.sessionId)
    await expect
      .poll(() => history(resumed.sessionId))
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
