import { expect, type Page } from '@playwright/test'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { committed, status, test, type MigrationApp } from './fixtures/migration-app'
import { laneRow, serviceView } from './fixtures/local-parity'
import { sidebarRows } from './fixtures/migration-sidebar'
import { draftText, routineName } from './fixtures/migration-world'
import type { LocalDaemon } from './fixtures/local-daemon'

async function advanced(page: Page) {
  await page
    .getByTestId('account-footer')
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Advanced', exact: true })
    .click()
  return settings
}

test('a missing parked transcript fails G6 before commit; in-app keeps its data and offers Retry', async ({
  migration: m,
}) => {
  const before = await m.world.manifest()
  const displaced = join(m.daemon.root, 'displaced.archived')
  await rename(m.world.parkedFile, displaced)
  const page = await m.start()
  const failure = { step: 'verify', code: 'gate-g6' }
  expect(await status(page)).toMatchObject({ mode: 'in-app', migration: 'failed', failure })
  expect(await m.journal()).toMatchObject({ state: 'aborted', failure })
  await rename(displaced, m.world.parkedFile)
  expect(await m.world.manifest()).toEqual(before)
  await sidebarRows(page, m.world, false)
  const settings = await advanced(page)
  await expect(settings.getByText('Couldn’t finish setting up the Phosphor service.')).toBeVisible()
  await expect(settings.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
})

async function stopLanes(page: Page, daemon: LocalDaemon) {
  // Opening Desktop warms the open lane (`ready.warmOnOpen`). Stop only after that
  // start lands: a resume that lands after the check makes the restore refuse.
  await expect
    .poll(async () => (await serviceView(page, daemon))?.lanes.some((l) => l.activity === 'idle'))
    .toBe(true)
  const view = await serviceView(page, daemon)
  for (const lane of view!.lanes.filter((lane) => lane.activity !== 'stopped')) {
    await laneRow(page, daemon, lane.laneId).click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .getByRole('button', { name: 'Stop', exact: true })
      .click()
  }
  await expect
    .poll(async () =>
      (await serviceView(page, daemon))?.lanes.every((l) => l.activity === 'stopped'),
    )
    .toBe(true)
}

async function restoreAndRetry(m: MigrationApp) {
  const before = await m.world.manifest()
  const page = await m.start()
  await committed(page)
  await stopLanes(page, m.daemon)
  // Act as launchd only AFTER the real release made the foreground daemon exit 75.
  const [restored] = await Promise.all([
    m.start({}, ['--restore-in-app-runtime']),
    (async () => {
      await expect.poll(m.daemon.exitCode, { timeout: 40_000 }).toBe(75)
      await m.daemon.restart()
    })(),
  ])
  expect(await status(restored)).toMatchObject({ mode: 'in-app', migration: 'reverted' })
  const blocked = await m.journal()
  expect(blocked.state).toBe('reverted')
  const next = await m.start()
  expect(await status(next)).toMatchObject({ mode: 'in-app', migration: 'reverted' })
  expect(await m.journal()).toEqual(blocked)
  const rows = await sidebarRows(next, m.world, false)
  expect(rows).toContainEqual(
    expect.objectContaining({ title: m.world.lanes.worktree.name, group: 'Pinned' }),
  )
  expect(rows).toContainEqual(
    expect.objectContaining({ title: m.world.lanes.removedWorktree.name, marker: '🔥' }),
  )
  await expect(next.locator('main textarea')).toHaveValue(draftText)
  expect(
    (await next.evaluate(() => window.phosphor.invoke('routines:list'))).routines.map(
      (r) => r.name,
    ),
  ).toEqual([routineName])
  expect(await m.world.manifest()).toEqual(before)
  const settings = await advanced(next)
  await expect(settings.getByText('Service setup was reverted.')).toBeVisible()
  await settings.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect.poll(m.journal).toMatchObject({ state: 'reverted', retryRequested: true })
  const retry = await m.start()
  expect((await m.journal()).migrationId).not.toBe(blocked.migrationId)
  return retry
}

test('break-glass restores original data and stays in-app across restart until explicit Retry', async ({
  migration,
}) => {
  await restoreAndRetry(migration)
})

test('explicit Retry after break-glass finishes the second migration', async ({ migration }) => {
  await committed(await restoreAndRetry(migration))
})
