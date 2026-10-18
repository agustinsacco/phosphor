import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSkillZip,
  forgetKnownSkillDir,
  isWritableSkillDir,
  LEGACY_SKILL_SIDECAR,
  readSidecar,
  readSkillFileEntry,
  registerKnownSkillDir,
  replaceKnownSkillDirs,
  requireKnownPath,
  requireKnownSkillDir,
  SKILL_SIDECAR,
  skillRoots,
  walkBundle,
  within,
} from './bundle'
import { readZipEntries } from '../zip'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-bundle-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', root)
  replaceKnownSkillDirs([])
})
afterEach(async () => {
  vi.unstubAllEnvs()
  replaceKnownSkillDirs([])
  await rm(root, { recursive: true, force: true })
})

it('keeps one normalized registry for replacement, registration and forgetting', () => {
  const dir = join(root, 'skill')
  registerKnownSkillDir(join(dir, '.'))
  expect(requireKnownSkillDir(dir)).toBe(dir)
  expect(requireKnownPath(dir, 'SKILL.md')).toBe(join(dir, 'SKILL.md'))
  expect(requireKnownPath(dir, '.')).toBe(dir)
  expect(() => requireKnownPath(dir, '../outside')).toThrow('path escapes')
  replaceKnownSkillDirs([join(root, 'next')])
  expect(() => requireKnownSkillDir(dir)).toThrow('unknown')
  forgetKnownSkillDir(join(root, 'next'))
  expect(() => requireKnownSkillDir(join(root, 'next'))).toThrow('unknown')
})

it('allows only strict descendants of the user and active project writable roots', () => {
  const roots = skillRoots(root)
  expect(roots).toEqual({
    userRoot: join(root, 'skills'),
    projectRoot: join(root, '.pi', 'skills'),
  })
  expect(skillRoots()).toEqual({ userRoot: join(root, 'skills') })
  expect(isWritableSkillDir(join(roots.userRoot, 'skill'))).toBe(true)
  expect(isWritableSkillDir(roots.userRoot)).toBe(false)
  expect(isWritableSkillDir(join(root, 'skills-other', 'skill'))).toBe(false)
  expect(isWritableSkillDir(join(roots.projectRoot!, 'skill'))).toBe(false)
  expect(isWritableSkillDir(join(roots.projectRoot!, 'skill'), root)).toBe(true)
  expect(within(root, root)).toBe(false)
})

it('falls back only on sidecar read failure, not malformed current provenance', async () => {
  await writeFile(
    join(root, LEGACY_SKILL_SIDECAR),
    JSON.stringify({ catalogId: 'old', repo: 'repo', sha: 'sha' }),
  )
  expect(await readSidecar(root)).toEqual({
    catalogId: 'old',
    repo: 'repo',
    sha: 'sha',
    installedAt: 0,
    subpath: '',
  })
  await writeFile(join(root, SKILL_SIDECAR), 'invalid json')
  expect(await readSidecar(root)).toBeUndefined()
  await writeFile(join(root, SKILL_SIDECAR), JSON.stringify({ repo: 'missing fields' }))
  expect(await readSidecar(root)).toBeUndefined()
})

it('walks files before subdirectories with a shared budget, hiding sidecars and excluded directories', async () => {
  for (const child of ['nested', '.hidden', 'node_modules']) {
    await mkdir(join(root, child))
    await writeFile(join(root, child, 'child.txt'), 'child')
  }
  await writeFile(join(root, 'SKILL.md'), 'body')
  await writeFile(join(root, SKILL_SIDECAR), '{}')
  await writeFile(join(root, LEGACY_SKILL_SIDECAR), '{}')
  expect(await walkBundle(root)).toEqual([
    { path: 'SKILL.md', size: 4 },
    { path: 'nested/child.txt', size: 5 },
  ])
  expect(await walkBundle(root, '', { left: 1 })).toEqual([{ path: 'SKILL.md', size: 4 }])
  expect(await walkBundle(join(root, 'absent'))).toEqual([])
  registerKnownSkillDir(root)
  expect(await readSkillFileEntry(root, 'SKILL.md')).toEqual({
    content: 'body',
    binary: false,
    size: 4,
  })
  const zip = await buildSkillZip(root)
  expect(readZipEntries(zip.data).map((entry) => entry.path)).toEqual([
    `${zip.fileName.slice(0, -4)}/SKILL.md`,
    `${zip.fileName.slice(0, -4)}/nested/child.txt`,
  ])
})
