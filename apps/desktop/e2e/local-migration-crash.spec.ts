import { expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { committed, status, test } from './fixtures/migration-app'
import { sidebarRows } from './fixtures/migration-sidebar'

// Before a recovery window can legitimately update prefs or start SQLite, verify the live
// prefs (including drafts and order) and DB byte-for-byte against step 2's durable manifest.
async function assertPreCommitBackup(userData: string, id: string) {
  const path = join(userData, 'daemon-migration', `backup-${id}`, 'backup.json')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as {
    entries: { name: string; sha256: string }[]
  }
  for (const name of ['config.json', 'routines.sqlite']) {
    const hash = createHash('sha256')
      .update(await readFile(join(userData, name)))
      .digest('hex')
    expect(manifest.entries).toContainEqual(expect.objectContaining({ name, sha256: hash }))
  }
}

// D1 §3.7 step numbers; the runner additionally imports artifacts before routines.
for (const [number, step, state] of [
  [2, 'backup', 'running'],
  [8, 'lanes', 'running'],
  [11, 'routines', 'running'],
  [13, 'commit-request', 'commit-requested'],
  [14, 'commit', 'committed'],
  [15, 'device', 'committed'],
  [16, 'quarantine', 'committed'],
] as const) {
  test(`SIGKILL after ${number} (${step}): ${state === 'running' ? 'retry from scratch' : 'roll forward only'}`, async ({
    migration: m,
  }) => {
    const before = await m.world.manifest()
    await expect(m.start({ PHOSPHOR_MIGRATION_CRASH_AT: `${step}:after` })).rejects.toThrow()
    const crash = await m.journal()
    expect(crash.state).toBe(state)
    expect(crash.steps.at(-1)).toMatchObject({ step, status: 'done' })
    expect(await m.world.manifest()).toEqual(before)
    if (state === 'running') await assertPreCommitBackup(m.daemon.roots.userData, crash.migrationId)
    if (number === 2 || number === 13) {
      await m.daemon.stop()
      const down = await m.start()
      if (number === 2) {
        expect(await status(down)).toMatchObject({ mode: 'in-app', migration: 'waiting' })
        await sidebarRows(down, m.world, false)
        expect(await m.world.manifest()).toEqual(before)
      } else {
        expect(await status(down)).toMatchObject({ mode: 'daemon' })
        await expect(down.getByTestId('session-row')).toHaveCount(0)
        expect((await m.journal()).state).toBe('commit-requested')
      }
      await m.close()
      await m.daemon.restart()
    }
    const page = await m.start()
    await committed(page)
    const final = await m.journal()
    expect(final.state).toBe('committed')
    for (const done of ['device', 'quarantine', 'done'])
      expect(final.steps).toContainEqual(expect.objectContaining({ step: done, status: 'done' }))
    if (state === 'running') {
      expect(final.migrationId).not.toBe(crash.migrationId)
      expect(final.attempts[final.desktopVersion]).toBe(1)
      if (number !== 2) {
        const log = await readFile(join(m.daemon.roots.stateDir, 'logs/phosphor.log'), 'utf8')
        expect(log).toContain(`owner.migrate.aborted {"migrationId":"${crash.migrationId}"`)
      }
    } else expect(final.migrationId).toBe(crash.migrationId)
    await sidebarRows(page, m.world, true)
  })
}
