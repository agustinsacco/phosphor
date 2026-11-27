import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown } from './fixtures/local-app'
import { localDaemonFixture } from './fixtures/local-daemon'
import { laneRow, serviceView, sidebar } from './fixtures/local-parity'
import {
  addedFolder,
  addedRoutine,
  changedTitle,
  findCreated,
  issuerTitle,
  originalTitle,
  routineArgs,
  sendOp,
  startIssuer,
} from './fixtures/agent-sync'

test('service-owned Desktop projects lane, folder, Archive and routine changes made by an agent', async () => {
  const daemon = await localDaemonFixture({
    agentOps: true,
    repositories: async ({ home }) => {
      const repo = join(home, 'registered')
      await mkdir(repo)
      await mkdir(join(home, addedFolder))
      return [repo]
    },
  })
  try {
    const harness = await launch({
      workspace: join(daemon.roots.home, 'registered'),
      env: {
        ...daemon.desktopEnv,
        HOME: daemon.roots.home,
        CFFIXED_USER_HOME: daemon.roots.home,
        TMPDIR: daemon.root,
        XDG_CONFIG_HOME: daemon.roots.configHome,
        XDG_STATE_HOME: daemon.roots.stateHome,
        PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
      },
    })
    try {
      const { page } = harness
      await expect
        .poll(() => serviceView(page, daemon))
        .toMatchObject({ state: 'ready', local: true, ops: true })
      const { sessionId, repositoryId } = await startIssuer(page, daemon.machineId)
      const op = (args: string[]) => sendOp(page, sessionId, args)
      await op(['lane.create', '--folder', repositoryId, '--name', originalTitle])
      const laneId = await findCreated(page, daemon.machineId)
      const row = laneRow(page, daemon, laneId)
      await expect(row).toContainText(originalTitle)
      await op(['lane.rename', '--ref', laneId, changedTitle])
      await expect(row).toContainText(changedTitle)
      await op(['lane.pin', '--ref', laneId, 'on'])
      await expect
        .poll(
          async () =>
            (await serviceView(page, daemon))?.lanes.find((l) => l.laneId === laneId)?.pinned,
        )
        .toBe(true)
      await op(['lane.marker', '--ref', laneId, '🚀'])
      await expect(row.getByTestId('lane-marker')).toBeVisible()
      await op(['folder.add', addedFolder])
      await expect(sidebar(page).getByText(addedFolder, { exact: true })).toBeVisible()
      await sidebar(page).getByRole('button', { name: issuerTitle, exact: true }).click()
      await expect(page.getByPlaceholder(/Describe a task…/i)).toBeVisible()
      await page.getByRole('button', { name: 'Archive', exact: true }).first().click()
      await expect(page.getByText('No archived lanes.')).toBeVisible()
      await op(['lane.archive', laneId])
      const confirm = page.getByRole('button', { name: 'Approve', exact: true })
      await confirm.click()
      await expect(row).toHaveCount(0)
      const archive = page.getByTestId('archive-row').filter({ hasText: changedTitle })
      await expect(archive).toBeVisible()
      await op(['archive.restore', laneId])
      await expect(archive).toHaveCount(0)
      await expect(row).toContainText(changedTitle)
      await page.getByRole('button', { name: 'Routines', exact: true }).first().click()
      await op(routineArgs(repositoryId))
      await expect(page.getByTestId('global-page')).toContainText(addedRoutine)
    } finally {
      await shutdown(harness)
    }
  } finally {
    await daemon.close()
  }
})
