import { expect, test as base, type Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { localDaemonFixture, type LocalDaemon } from './local-daemon'
import { launch, shutdown, type Harness } from './local-app'
import { seedWorld, folderName } from './local-parity-world'
import { LOCAL_MACHINE_LABEL } from './local-machine'

export { savedTitle, folderName } from './local-parity-world'
export const sidebar = (page: Page) =>
  page.getByRole('region', { name: LOCAL_MACHINE_LABEL, exact: true })
export const serviceView = (page: Page, daemon: LocalDaemon) =>
  page.evaluate(
    async (id) => (await window.phosphor.invoke('hosts:snapshot'))[id],
    daemon.machineId,
  )

export const test = base.extend<{ parity: { page: Page; daemon: LocalDaemon } }>({
  parity: async ({ browserName: _browserName }, use) => {
    const daemon = await localDaemonFixture({
      repositories: async ({ home, agentDir, stateDir }) => {
        const repo = join(home, folderName)
        await mkdir(repo)
        await seedWorld(agentDir, repo, stateDir, true)
        return [repo]
      },
    })
    let harness: Harness | undefined
    try {
      // Different agent directories make any accidental in-app read observable.
      const home = join(daemon.root, 'desktop-home'),
        agent = join(home, 'agent')
      await mkdir(agent, { recursive: true, mode: 0o700 })
      const workspace = join(home, 'frozen-workspace')
      await mkdir(workspace)
      await seedWorld(agent, workspace, daemon.desktopEnv.PHOSPHOR_TEST_USER_DATA, false)
      await writeFile(
        join(daemon.desktopEnv.PHOSPHOR_TEST_USER_DATA, 'config.json'),
        JSON.stringify({
          lastWorkspacePath: workspace,
          recentWorkspaces: [{ path: workspace, name: 'frozen-workspace' }],
          maintenance: { enabled: false },
        }),
      )
      harness = await launch({
        workspace,
        env: {
          ...daemon.desktopEnv,
          PI_CODING_AGENT_DIR: agent,
          HOME: home,
          CFFIXED_USER_HOME: home,
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_STATE_HOME: join(home, 'state'),
          TMPDIR: daemon.root,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CODEX_HOME: join(home, '.codex'),
          PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
        },
      })
      const { page } = harness
      page.setDefaultTimeout(15_000)
      await expect
        .poll(() => serviceView(page, daemon))
        .toMatchObject({ local: true, ownerLocal: true, state: 'ready' })
      await use({ page, daemon })
    } finally {
      try {
        if (harness) await shutdown(harness)
      } finally {
        await daemon.close()
      }
    }
  },
})
