import { join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { baseRoutines } from './migration/__fixtures__/base-desktop'
import { world, source, ports, permit } from './migration/__fixtures__/post-commit-world'
import { createPostCommitSteps } from './migration/post-commit-steps'
import { readJournal } from './migration/journal'
import { restoreInAppRuntime } from './restore'

let w: ReturnType<typeof world>
beforeEach(async () => {
  w = world()
  const input = { ...w, log: vi.fn() }
  const steps = createPostCommitSteps(ports)
  await steps.device!(input)
  await steps.quarantine!(input)
})
afterEach(() => rmSync(w.userData, { recursive: true, force: true }))
const service = () => ({
  stopLanes: vi.fn(async () => true),
  releaseToStandby: vi.fn(async () => true),
})
it('stops then releases before restoring only migration keys, salvaging the original DB even if the old opener ran', async () => {
  const owner = service()
  w.write({ ...w.read(), theme: 'light', localRuntime: { mode: 'daemon' } })
  expect(baseRoutines(w.userData)).toEqual([])
  await restoreInAppRuntime({ ...ports, ...owner, permit, userData: w.userData })
  expect(owner.stopLanes.mock.invocationCallOrder[0]).toBeLessThan(
    owner.releaseToStandby.mock.invocationCallOrder[0]!,
  )
  expect(w.read()).toMatchObject({
    theme: 'light',
    lastSessionPath: source,
    pinnedSessions: w.config.pinnedSessions,
    drafts: { [`session:${source}`]: { text: 'hello', attachments: [] } },
  })
  expect(w.read().localRuntime).toBeUndefined()
  expect(w.read().lastLocal).toBeUndefined()
  expect(baseRoutines(w.userData)).toEqual([{ name: 'routine' }])
  expect(readJournal(w.writer.dir)).toMatchObject({ journal: { state: 'reverted' } })
})
it.each(['stopLanes', 'releaseToStandby'] as const)(
  'a refused %s leaves the data quarantined and journal committed',
  async (method) => {
    const owner = service()
    owner[method].mockResolvedValue(false)
    const before = w.read()
    await expect(
      restoreInAppRuntime({ ...ports, ...owner, permit, userData: w.userData }),
    ).rejects.toThrow()
    expect(w.read()).toEqual(before)
    expect(baseRoutines(w.userData)).toEqual([])
    expect(readJournal(w.writer.dir)).toMatchObject({ journal: { state: 'committed' } })
  },
)
it('refuses a changed backup before stopping any service lanes', async () => {
  const file = join(w.backupDir, 'config.json')
  writeFileSync(file, readFileSync(file, 'utf8') + ' ')
  const owner = service()
  await expect(
    restoreInAppRuntime({ ...ports, ...owner, permit, userData: w.userData }),
  ).rejects.toThrow()
  expect(owner.stopLanes).not.toHaveBeenCalled()
})

it('refuses the other runtime’s routines filename before stopping lanes', async () => {
  const owner = service()
  await expect(
    restoreInAppRuntime({
      userData: w.userData,
      permit,
      ...owner,
      routinesFile: 'routines-dev.sqlite',
    }),
  ).rejects.toThrow('routines database')
  expect(owner.stopLanes).not.toHaveBeenCalled()
  expect(readJournal(w.writer.dir)).toMatchObject({ journal: { state: 'committed' } })
})
