import { expect, test } from '@playwright/test'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { remoteHostFixture, REMOTE_TEST_TIMEOUT } from './fixtures/remote-host'
import { captures, openMachineSettings } from './fixtures/remote-ui'

test('Host agent behavior edits ordinary umask configuration without touching local defaults', async () => {
  test.setTimeout(Math.max(REMOTE_TEST_TIMEOUT, 90_000))
  const h = await remoteHostFixture({ native: true })
  try {
    const file = join(h.agent, 'settings.json')
    await writeFile(
      file,
      JSON.stringify({
        defaultProvider: 'fake',
        defaultModel: 'fake-model',
        compaction: { enabled: true, reserveTokens: 16384, model: 'preserve-on-host' },
        retry: { enabled: true, maxRetries: 3 },
      }),
    )
    await chmod(h.agent, 0o775)
    await chmod(file, 0o664)
    await h.signIn()
    const local = await h.page.evaluate(() => window.phosphor.invoke('pi:agentSettings'))
    const settings = await openMachineSettings(h, 'Agent defaults')
    await settings
      .getByRole('combobox', { name: 'Enable automatic compaction', exact: true })
      .selectOption('false')
    await settings.getByRole('button', { name: 'Review agent behavior', exact: true }).click()
    await h.page.getByRole('button', { name: 'Save behavior', exact: true }).click()
    await expect
      .poll(async () => JSON.parse(await readFile(file, 'utf8')).compaction.enabled)
      .toBe(false)
    expect(JSON.parse(await readFile(file, 'utf8')).compaction).toEqual({
      enabled: false,
      reserveTokens: 16384,
      model: 'preserve-on-host',
    })
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await h.page.evaluate(() => window.phosphor.invoke('pi:agentSettings'))).toEqual(local)
    await captures(h, test.info(), 'host-agent-behavior-parity')
    await settings
      .getByRole('navigation', { name: 'Machine settings', exact: true })
      .getByRole('button', { name: 'Skills & extensions', exact: true })
      .click()
    await expect(
      settings.getByRole('heading', { name: 'Standard Host extensions', exact: true }),
    ).toBeVisible()
    await expect(
      settings.getByRole('button', { name: 'Install Swarm subagents', exact: true }),
    ).toBeEnabled()
    await expect(
      settings.getByRole('button', { name: 'Install Web access', exact: true }),
    ).toBeEnabled()
    await expect(settings).toContainText('computer use is not installed')
    await settings.getByRole('button', { name: 'Install Swarm subagents', exact: true }).click()
    const review = h.page.getByRole('dialog')
    await expect(review).toContainText('pi install npm:pi-subagents')
    await review.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(JSON.parse(await readFile(file, 'utf8')).packages).toBeUndefined()
    await captures(h, test.info(), 'host-headless-extensions')
  } finally {
    await h.close()
  }
})
