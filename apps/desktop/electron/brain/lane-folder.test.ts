import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BRAIN_AGENT_RULES,
  ensureBrainLane,
  readBrainRules,
} from '@phosphor/brain-runtime/agent/rules'
import { brainLaneFolder, isBrainLaneFolder, laneBrainLaunch } from './lane-folder'

let root: string
beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'brain-folder-')))
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('names <userData>/brain/Brain by its real path, before and after it exists', async () => {
  const userData = join(root, 'userData')
  await mkdir(userData)
  await symlink(userData, join(root, 'alias'))
  const folder = join(userData, 'brain', 'Brain')
  expect(brainLaneFolder(join(root, 'alias'))).toBe(folder)
  await ensureBrainLane(folder)
  expect(brainLaneFolder(join(root, 'alias'))).toBe(folder)
  expect(isBrainLaneFolder(join(root, 'alias', 'brain', 'Brain'), folder)).toBe(true)
  expect(isBrainLaneFolder(userData, folder)).toBe(false)
  expect(isBrainLaneFolder(join(root, 'missing'), folder)).toBe(false)
})

it('hands the Brain lane Brain Agent’s tools and its rules, and every other lane recall', async () => {
  const folder = join(root, 'brain', 'Brain')
  const service = {
    recallLaunch: vi.fn(async () => ({ extensions: ['/brain.mjs'], skills: [] })),
    curatorLaunch: vi.fn(async () => ({
      connection: { endpoint: '/rpc.sock', token: 'curator' },
      extensions: ['/brain-curator.mjs'],
      skills: [],
    })),
  }
  await mkdir(join(root, 'repo'))
  expect(
    (await laneBrainLaunch(join(root, 'repo'), folder, async () => service))?.extensions,
  ).toEqual(['/brain.mjs'])
  expect(await readBrainRules(folder)).toBeNull()
  await mkdir(folder, { recursive: true })
  expect((await laneBrainLaunch(folder, folder, async () => service))?.extensions).toEqual([
    '/brain-curator.mjs',
  ])
  expect(await readBrainRules(folder)).toBe(BRAIN_AGENT_RULES)
  expect(service.recallLaunch).toHaveBeenCalledTimes(1)
  expect(service.curatorLaunch).toHaveBeenCalledTimes(1)
})
