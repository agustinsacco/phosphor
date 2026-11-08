import type * as FsPromises from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { machine, writeLane } from './__fixtures__/lane'
import { openArchive } from './archive'
import { installLane } from './install'
import { exportLane, sessionTaken } from './move'

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof FsPromises>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (to.endsWith('session-map.json'))
        throw Object.assign(new Error('disk failure'), { code: 'ENOSPC' })
      return actual.rename(from, to)
    },
  }
})

it('leaves existing Claude pairings intact when publishing their replacement fails', async () => {
  const from = machine('map-source')
  const to = machine('map-target')
  const cwd = join(from.home, 'notes')
  const target = join(to.home, 'notes')
  mkdirSync(cwd)
  mkdirSync(target)
  const lane = writeLane(from, cwd)
  const archivePath = join(from.home, 'bundle')
  await exportLane(
    {
      sessionFile: lane.sessionFile,
      workspace: 'notes',
      paths: from,
      attachmentAllowed: () => false,
    },
    archivePath,
  )
  const map = join(to.home, '.pi', 'agent', 'pi-claude-cli', 'session-map.json')
  mkdirSync(join(to.home, '.pi', 'agent', 'pi-claude-cli'), { recursive: true })
  const original = '{"unrelated-session":"unrelated-cli"}\n'
  writeFileSync(map, original)
  await expect(
    installLane({
      archive: await openArchive(archivePath),
      plan: { mode: 'folder', branch: null, workspace: 'notes', blockers: [] },
      cwd: target,
      paths: to,
      labels: { from: 'a', to: 'b' },
      attachmentsDir: null,
      sessionTaken: sessionTaken(to),
    }),
  ).rejects.toThrow('disk failure')
  expect(readFileSync(map, 'utf8')).toBe(original)
})
