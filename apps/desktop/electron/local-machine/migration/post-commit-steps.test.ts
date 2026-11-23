import { backupUserData } from './backup'
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { remoteLaneResourceKey, remoteLaneKey } from '@shared/remote-host'
import { remotePrKey } from '@shared/host-protocol-github'
import { baseGetPrefs, baseRoutines } from './__fixtures__/base-desktop'
import { MACHINE_ID, MIGRATION_ID, REPO } from './__fixtures__/plan-facts'
import { world, source, otherPin, ports } from './__fixtures__/post-commit-world'
import { createPostCommitSteps } from './post-commit-steps'

let w: ReturnType<typeof world>
beforeEach(() => {
  w = world()
})
afterEach(() => rmSync(w.userData, { recursive: true, force: true }))
const log = vi.fn()
it('maps drafts, collapse, order and last lane from backup, not from partially rewritten prefs', async () => {
  const input = { ...w, log }
  const run = createPostCommitSteps(ports).device!
  await run(input)
  const first = w.read()
  await run(input)
  expect(w.read()).toEqual(first)
  const id = w.plan.laneIds[source]!
  const repo = w.plan.repositoryIds[REPO]!
  const key = remoteLaneResourceKey(MACHINE_ID, id)
  expect(first).toMatchObject({
    lastLocal: { repositoryId: repo, laneId: id },
    sessionOrder: [remoteLaneKey(MACHINE_ID, id), 'host:other/lane:l'],
    collapsedWorkspaces: [remotePrKey(MACHINE_ID, repo), 'host:other/repo:z'],
  })
  const home = `home:host:${MACHINE_ID}/machine`
  expect(first.drafts).toEqual({
    [otherPin]: w.config.drafts[otherPin],
    [key]: {
      ...w.config.drafts[`session:${source}`],
      key,
      workspacePath: remoteLaneKey(MACHINE_ID, id),
    },
    [home]: {
      ...w.config.drafts[`home:${REPO}`],
      key: home,
      workspacePath: remotePrKey(MACHINE_ID, repo),
    },
  })
  expect(log).toHaveBeenCalledWith('device-rekey', { orphans: 4 })
})
it('a base Desktop resumes nothing and opens zero routines, even across a partially completed rename', async () => {
  expect(baseGetPrefs(w.userData).recentWorkspaces).toHaveLength(1)
  expect(baseRoutines(w.userData)).toEqual([{ name: 'routine' }])
  const file = join(w.userData, 'routines.sqlite')
  renameSync(file, `${file}.migrated-${MIGRATION_ID}`)
  const run = createPostCommitSteps(ports).quarantine!
  await run({ ...w, log })
  await run({ ...w, log })
  const prefs = baseGetPrefs(w.userData)
  expect(prefs.lastWorkspacePath).toBeUndefined()
  expect(prefs.lastSessionPath).toBeUndefined()
  expect(prefs.recentWorkspaces).toEqual([])
  expect(prefs.pinnedSessions).toEqual([otherPin])
  expect(prefs.laneMarkers).toEqual({ [otherPin]: 'b' })
  expect(baseRoutines(w.userData)).toEqual([])
  expect(existsSync(`${file}.migrated-${MIGRATION_ID}`)).toBe(true)
})

it.each([true, false])(
  'resolves folder aliases from the plan, preferring the exact home when present (%s)',
  async (exact) => {
    const alias = '/old/spelling'
    const home = `home:host:${MACHINE_ID}/machine`
    const plan = { ...w.plan, folderAliases: { [alias]: w.plan.repositoryIds[REPO]! } }
    const drafts = {
      ...w.config.drafts,
      ...(exact ? { [`home:${alias}`]: { text: 'exact' } } : {}),
    }
    w.write({ ...w.config, lastWorkspacePath: alias, collapsedWorkspaces: [alias], drafts })
    backupUserData({ ...w, ...ports, migrationId: MIGRATION_ID })
    await createPostCommitSteps(ports).device!({ ...w, plan, log })
    expect(w.read()).toMatchObject({
      lastLocal: { repositoryId: w.plan.repositoryIds[REPO] },
      collapsedWorkspaces: [remotePrKey(MACHINE_ID, w.plan.repositoryIds[REPO]!)],
      drafts: { [home]: { text: exact ? 'exact' : 'hello' } },
    })
  },
)

it('does not capture a later generation of SQLite sidecars on quarantine replay', async () => {
  const run = createPostCommitSteps(ports).quarantine!
  await run({ ...w, log })
  const wal = join(w.userData, 'routines.sqlite-wal')
  writeFileSync(wal, 'later wal')
  await run({ ...w, log })
  expect(existsSync(wal)).toBe(true)
  expect(existsSync(`${wal}.migrated-${MIGRATION_ID}`)).toBe(false)
})
