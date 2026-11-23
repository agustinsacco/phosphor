import { expect } from '@playwright/test'
import { committed, test } from './fixtures/migration-app'
import { routineName, liveArtifact, deletedArtifact } from './fixtures/migration-world'

test('migrated routines and both artifact conversations are served after relaunch', async ({
  migration: m,
}) => {
  await committed(await m.start())
  const page = await m.start()
  await committed(page)
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
