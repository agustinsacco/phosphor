import { expect } from '@playwright/test'
import { committed, test } from './fixtures/migration-app'
import { sidebarRows } from './fixtures/migration-sidebar'
import {
  archiveName,
  draftText,
  routineName,
  liveArtifact,
  deletedArtifact,
} from './fixtures/migration-world'

test('migrated routines and both artifact conversations are served after relaunch', async ({
  migration: m,
}) => {
  await committed(await m.start())
  const page = await m.start()
  await committed(page)
  const archives = await page.evaluate(() =>
    window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'archive.list', args: {} }),
  )
  expect(archives).toMatchObject({
    status: 'ok',
    data: { entries: [{ title: archiveName, state: 'archived' }] },
  })
  const routines = await page.evaluate(
    (id) => window.phosphor.invoke('routines:list', `host:${id}`),
    m.daemon.machineId,
  )
  expect(routines.routines.map((r) => r.name)).toEqual([routineName])
  await expect
    .poll(() => page.evaluate(() => window.phosphor.invoke('artifacts:list', [])))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: liveArtifact, sessionDeleted: false }),
        expect.objectContaining({ title: deletedArtifact, sessionDeleted: true }),
      ]),
    )
})

test('sidebar keeps its folders, removed worktree, order, pin and marker after relaunch', async ({
  migration: m,
}) => {
  const before = await sidebarRows(await m.start({ PHOSPHOR_E2E_OWNER_KEY: '' }), m.world, false)
  expect(before).toHaveLength(4)
  expect(before).toContainEqual(
    expect.objectContaining({ title: m.world.lanes.worktree.name, group: 'Pinned' }),
  )
  expect(before).toContainEqual(
    expect.objectContaining({ title: m.world.lanes.removedWorktree.name, marker: '🔥' }),
  )
  await committed(await m.start())
  const page = await m.start()
  await committed(page)
  expect(await sidebarRows(page, m.world, true)).toEqual(before)
})

test('relaunch selects the re-keyed last lane and restores its unsent draft', async ({
  migration: m,
}) => {
  await committed(await m.start())
  const page = await m.start()
  await committed(page)
  await expect(
    page.getByTestId('remote-session-row').filter({ hasText: m.world.lanes.checkout.name }),
  ).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('main textarea')).toHaveValue(draftText)
})
