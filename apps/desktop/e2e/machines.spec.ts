import { desktopElectronLaunchOptions } from '../../../tools/scripts/desktop-electron-launch.mjs'
import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { scratchDir } from './fixtures/scratch'
import { configureTestTeardown } from './fixtures/shutdown'

/**
 * The Machines preview, through the built app: off by default, then the
 * machine-aware sidebar, the Machines page, a lane finishing on another
 * machine and Run on, against the made-up bee1 and bee2, and off again.
 */

async function launch(existing?: string) {
  const scratch = existing ?? (await scratchDir('phosphor-machines-'))
  // Named like the made-up lanes' project, so they join this group.
  const workspace = join(scratch, 'phosphor')
  const userData = join(scratch, 'prefs')
  // A second project with nothing on the made-up machines.
  const notes = join(scratch, 'notes')
  if (!existing) {
    await mkdir(workspace)
    await mkdir(notes)
    await mkdir(userData)
    const recentWorkspaces = [workspace, notes].map((path, i) => ({
      path,
      name: path.split('/').pop(),
      lastOpenedAt: Date.now() - i,
    }))
    await writeFile(
      join(userData, 'config.json'),
      JSON.stringify({ lastWorkspacePath: workspace, recentWorkspaces }),
    )
  }
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.ELECTRON_CLI_ARGS
  const app = await electron.launch({
    ...desktopElectronLaunchOptions([resolve(import.meta.dirname, '..')]),
    env: {
      ...env,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: resolve(import.meta.dirname, 'fixtures/pi-stub.cjs'),
      PHOSPHOR_TEST_USER_DATA: userData,
      PI_CODING_AGENT_DIR: join(scratch, 'agent'),
    },
  })
  configureTestTeardown(app)
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return {
    page,
    scratch,
    /** Quit; keep the profile for another launch. */
    quit: () => app.close(),
    close: async () => {
      await app.close()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

async function setPreview(page: Page, on: boolean): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Advanced', exact: true }).click()
  const toggle = page
    .locator('[data-setting-row]', { hasText: 'Machines (preview)' })
    .getByRole('switch')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
  await page.keyboard.press('Escape')
}

test('tries machines against made-up Hosts, and leaves nothing behind when off', async () => {
  const { page, close } = await launch()
  const filter = page.getByTestId('machine-filter')
  const remoteRows = page.getByTestId('remote-lane-row')
  const machinesNav = page.getByRole('button', { name: 'Machines', exact: true })
  try {
    // One real lane on this computer.
    const home = page.getByPlaceholder('Describe a task or ask a question')
    await home.fill('Update hello.ts')
    await page.getByRole('button', { name: /Start session/i }).click()
    const localRow = page.getByTestId('session-row').first()
    await expect(localRow).toBeVisible()
    await page.getByRole('button', { name: 'New', exact: true }).click()
    // And an empty project, open so its group shows, with nothing on bee1.
    await page.getByTestId('workspace-chip').click()
    await page.getByRole('button', { name: 'notes', exact: true }).click()
    await expect(page.getByTestId('workspace-chip')).toContainText('notes')

    // Off by default: the sidebar and home screen are today's.
    await expect(
      page.evaluate(() => window.phosphor.invoke('app:setMachinesPreview', 'yes' as never)),
    ).rejects.toThrow(/Invalid preview flag/)
    await expect(filter).toHaveCount(0)
    await expect(machinesNav).toHaveCount(0)
    await expect(page.getByTestId('lane-machine')).toHaveCount(0)
    await expect(page.getByTestId('run-on')).toHaveCount(0)

    await setPreview(page, true)
    // This computer's lane says where it runs; bee1 and bee2's join the same
    // project, and a project only bee1 has gets its own group.
    await expect(localRow.getByTestId('lane-machine')).toHaveText(/^(Mac|Local)$/)
    await expect(remoteRows).toHaveCount(4)
    await expect(
      page.locator('[data-testid="remote-lane-row"][data-machine="bee2"]'),
    ).toContainText('bee2 · down')
    await expect(page.getByTestId('remote-project-group')).toHaveCount(1)
    await expect(page.getByTestId('remote-project-group')).toContainText('on bee1')

    const notesGroup = page.getByTestId('workspace-group').filter({ hasText: /^notes$/i })
    await expect(notesGroup).toHaveCount(1)
    await filter.getByRole('button', { name: 'bee1' }).click()
    // Only projects with lanes on bee1.
    await expect(notesGroup).toHaveCount(0)
    await expect(page.getByTestId('session-row')).toHaveCount(0)
    await expect(remoteRows).toHaveCount(3)
    await filter.getByRole('button', { name: /^This (Mac|computer)$/ }).click()
    await expect(remoteRows).toHaveCount(0)
    await expect(localRow).toBeVisible()
    await expect(notesGroup).toHaveCount(1)
    await filter.getByRole('button', { name: 'All' }).click()

    // The Machines page: this computer is real, a made-up Host's actions are off.
    await machinesNav.click()
    await expect(page.getByTestId('machine-row')).toHaveCount(3)
    await page.locator('[data-testid="machine-row"][data-machine="bee1"]').click()
    await page.getByRole('tab', { name: 'Logins' }).click()
    await expect(page.getByRole('button', { name: 'Sign in' }).first()).toBeDisabled()
    await page.getByRole('button', { name: '← All machines' }).click()
    await page.locator('[data-testid="machine-row"][data-machine="local"]').click()
    await page.getByRole('tab', { name: 'Logins' }).click()
    await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible()

    // A lane on bee1 finishes: the notice opens that lane.
    await page.getByRole('button', { name: 'Pretend a lane finishes' }).click()
    const toast = page.getByTestId('toast').filter({ hasText: 'Finished on bee1' })
    await expect(toast).toContainText('Host bundle on Linux')
    await toast.getByTestId('toast-open').click()
    await expect(page.getByTestId('remote-lane-view')).toContainText('Host bundle on Linux')
    await expect(page.locator('[data-machine="bee1"][data-state="done"]').first()).toBeVisible()

    // Opening a lane on this computer leaves the page, as it does for every page.
    await localRow.click()
    await expect(page.getByTestId('machines-page')).toHaveCount(0)

    // Run on: only this computer can be picked.
    await page.getByRole('button', { name: 'New', exact: true }).click()
    await page.getByTestId('run-on').click()
    await expect(page.getByRole('button', { name: 'bee1 preview', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'bee2 down', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')

    // Off again, on the Machines page: everything goes, the page included.
    await machinesNav.click()
    await setPreview(page, false)
    await expect(filter).toHaveCount(0)
    await expect(machinesNav).toHaveCount(0)
    await expect(remoteRows).toHaveCount(0)
    await expect(page.getByTestId('lane-machine')).toHaveCount(0)
    await expect(page.getByTestId('machines-page')).toHaveCount(0)
    await expect(localRow).toBeVisible()
  } finally {
    await close()
  }
})

test('the switch is remembered across a restart', async () => {
  const first = await launch()
  await setPreview(first.page, true)
  await expect(first.page.getByTestId('machine-filter')).toBeVisible()
  await first.quit()
  const second = await launch(first.scratch)
  try {
    await expect(second.page.getByTestId('machine-filter')).toBeVisible()
    await setPreview(second.page, false)
  } finally {
    await second.close()
  }
})
