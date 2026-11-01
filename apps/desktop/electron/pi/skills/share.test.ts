import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcSlashCommand } from '@shared/rpc'
import { registerKnownSkillDir, requireKnownSkillDir } from './bundle'
import { exportLocalSkill, installLocalSkill } from './share'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-share-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', root)
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const b64 = (text: string) => Buffer.from(text).toString('base64')
const bundle = (text = 'shared') => ({
  name: 'demo',
  files: [{ path: 'SKILL.md', data: b64(text) }],
})
const command = (path: string, scope: 'user' | 'project' = 'user'): RpcSlashCommand => ({
  name: 'skill:demo',
  source: 'skill',
  sourceInfo: { path, scope, source: 'local', origin: 'top-level' },
})

it('exports only a folder the last listing reported', async () => {
  const dir = join(root, 'skills', 'demo')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), 'body')
  expect(() => exportLocalSkill('demo', dir)).toThrow('unknown skill directory')
  registerKnownSkillDir(dir)
  expect(await exportLocalSkill('demo', dir)).toEqual({
    name: 'demo',
    files: [{ path: 'SKILL.md', data: b64('body') }],
  })
  expect(() => exportLocalSkill('../demo', dir)).toThrow('cannot be shared')
})

it('installs into the user root, then reports and replaces its own folder', async () => {
  expect(await installLocalSkill(bundle(), false, [])).toEqual({
    status: 'installed',
    replaced: false,
  })
  const folder = join(root, 'skills', 'demo')
  expect(requireKnownSkillDir(folder)).toBe(folder)
  const own = [command(join(folder, 'SKILL.md'))]
  expect(await installLocalSkill(bundle('next'), false, own)).toEqual({
    status: 'conflict',
    replaceable: true,
  })
  expect(await installLocalSkill(bundle('next'), true, own)).toEqual({
    status: 'installed',
    replaced: true,
  })
  expect(await readFile(join(folder, 'SKILL.md'), 'utf8')).toBe('next')
})

it('blocks a same-named global skill from elsewhere, but not a project one', async () => {
  const elsewhere = join(root, 'package', 'demo', 'SKILL.md')
  expect(await installLocalSkill(bundle(), true, [command(elsewhere)])).toEqual({
    status: 'conflict',
    replaceable: false,
  })
  expect(await installLocalSkill(bundle(), false, [command(elsewhere, 'project')])).toEqual({
    status: 'installed',
    replaced: false,
  })
})

it('refuses malformed bundles and flags from the renderer', async () => {
  await expect(installLocalSkill({ name: 'demo', files: [] }, false, [])).rejects.toThrow(
    'cannot be shared',
  )
  await expect(installLocalSkill(bundle(), 'yes', [])).rejects.toThrow('cannot be shared')
})
