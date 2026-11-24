import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  BRAIN_AGENT_RULES,
  BRAIN_AGENT_RULES_V7,
  brainLaneFolder,
  ensureBrainLane,
  isBrainLaneFolder,
  laneBrainLaunch,
  readBrainRules,
} from './lane-folder'

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

it('writes the default rules only while AGENTS.md is missing', async () => {
  const folder = join(root, 'brain', 'Brain')
  expect(await readBrainRules(folder)).toBeNull()
  await ensureBrainLane(folder)
  expect(await readBrainRules(folder)).toBe(BRAIN_AGENT_RULES)
  await writeFile(join(folder, 'AGENTS.md'), '# Owner rules')
  await ensureBrainLane(folder)
  expect(await readFile(join(folder, 'AGENTS.md'), 'utf8')).toBe('# Owner rules')
  expect(BRAIN_AGENT_RULES.split('\n')[0]).toBe('# Brain Agent')
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

it('upgrades only the exact v7 rules', async () => {
  expect(BRAIN_AGENT_RULES_V7).toBeTypeOf('string')
  for (const suffix of ['', '\n']) {
    await writeFile(join(root, 'AGENTS.md'), BRAIN_AGENT_RULES_V7 + suffix)
    await ensureBrainLane(root)
    expect(await readBrainRules(root)).toBe(
      suffix ? BRAIN_AGENT_RULES_V7 + suffix : BRAIN_AGENT_RULES,
    )
  }
  expect(BRAIN_AGENT_RULES).toContain('## Links')
})
