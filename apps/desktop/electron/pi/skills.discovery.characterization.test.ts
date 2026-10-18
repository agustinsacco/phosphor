import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeCommandsCached } from './commands'
import { packageSkillDirs } from './packages'
import {
  buildSkillZip,
  LEGACY_SKILL_SIDECAR,
  readSkillFileEntry,
  resolveSkills,
  SKILL_SIDECAR,
  writeSkillFileEntry,
} from './skills'
import { readZipEntries } from './zip'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
vi.mock('./commands', () => ({ probeCommandsCached: vi.fn() }))
vi.mock('./packages', () => ({ packageSkillDirs: vi.fn() }))

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-discovery-characterization-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', root)
  vi.mocked(probeCommandsCached).mockReset().mockResolvedValue([])
  vi.mocked(packageSkillDirs).mockReset().mockResolvedValue([])
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function seed(name: string, parent = join(root, 'skills')): Promise<string> {
  const dir = join(parent, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nbody`)
  return dir
}

it('uses fresh RPC first, deduplicates resolved directories and sorts by name', async () => {
  const zebra = await seed('zebra')
  const alpha = await seed('alpha')
  await seed('scan-only')
  vi.mocked(probeCommandsCached).mockResolvedValue([
    {
      name: 'zebra',
      source: 'skill',
      sourceInfo: {
        path: join(zebra, 'SKILL.md'),
        scope: 'user',
        source: 'rpc',
        origin: 'top-level',
      },
    },
    {
      name: 'duplicate',
      source: 'skill',
      sourceInfo: {
        path: join(zebra, '.', 'SKILL.md'),
        scope: 'project',
        source: 'duplicate',
        origin: 'package',
      },
    },
    {
      name: 'alpha',
      source: 'skill',
      sourceInfo: {
        path: join(alpha, 'SKILL.md'),
        scope: 'project',
        source: 'pkg',
        origin: 'package',
      },
    },
    { name: 'prompt', source: 'prompt' },
    { name: 'no-path', source: 'skill' },
  ])
  const options = { binaryPath: '/pi', workspacePath: root }
  const result = await resolveSkills(options)
  expect(probeCommandsCached).toHaveBeenCalledExactlyOnceWith(options, { fresh: true })
  expect(packageSkillDirs).not.toHaveBeenCalled()
  expect(result.probe).toBe('rpc')
  expect(
    result.skills.map(({ name, source, scope, writable }) => ({ name, source, scope, writable })),
  ).toEqual([
    { name: 'alpha', source: 'pkg', scope: 'project', writable: false },
    { name: 'zebra', source: 'rpc', scope: 'user', writable: true },
  ])
})

it.each(['empty', 'failure'] as const)(
  'labels scan fallback after an %s RPC result',
  async (kind) => {
    const dir = await seed('fallback')
    if (kind === 'failure') vi.mocked(probeCommandsCached).mockRejectedValue(new Error('offline'))
    const result = await resolveSkills({ binaryPath: '/pi' })
    expect(result.probe).toBe('scan')
    expect(result.skills.map((skill) => [skill.dir, skill.source])).toEqual([[dir, 'scan']])
  },
)

it('replaces the known-directory set on each resolution, including package read-only bundles', async () => {
  const dir = await seed('packaged', join(root, 'package'))
  vi.mocked(packageSkillDirs).mockResolvedValue([{ dir, scope: 'user', source: 'npm:demo' }])
  const result = await resolveSkills({})
  expect(result.skills[0]).toMatchObject({ dir, origin: 'package', writable: false })
  expect((await readSkillFileEntry(dir, 'SKILL.md')).content).toContain('packaged')
  await expect(writeSkillFileEntry(dir, 'SKILL.md', 'changed')).rejects.toThrow('read-only')
  vi.mocked(packageSkillDirs).mockResolvedValue([])
  await resolveSkills({})
  await expect(readSkillFileEntry(dir, 'SKILL.md')).rejects.toThrow('unknown skill directory')
})

it('reads legacy provenance, prefers the current sidecar and hides both from files and export', async () => {
  const dir = await seed('legacy')
  await writeFile(
    join(dir, LEGACY_SKILL_SIDECAR),
    JSON.stringify({ catalogId: 'old', repo: 'legacy', sha: 'pin' }),
  )
  expect((await resolveSkills({})).skills[0]?.provenance).toEqual({
    catalogId: 'old',
    repo: 'legacy',
    sha: 'pin',
    subpath: '',
    installedAt: 0,
  })
  await writeFile(
    join(dir, SKILL_SIDECAR),
    JSON.stringify({ catalogId: 'new', repo: 'current', sha: 'pin' }),
  )
  const result = await resolveSkills({})
  expect(result.skills[0]?.provenance?.repo).toBe('current')
  expect(result.skills[0]?.files.map((file) => file.path)).toEqual(['SKILL.md'])
  expect(readZipEntries((await buildSkillZip(dir)).data).map((entry) => entry.path)).toEqual([
    'legacy/SKILL.md',
  ])
})

it('enforces known-path containment and the text byte and binary limits', async () => {
  const dir = await seed('bounded')
  await writeFile(join(dir, 'limit.txt'), Buffer.alloc(2 * 1024 * 1024, 65))
  await writeFile(join(dir, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
  await writeFile(join(dir, 'binary'), Buffer.from([65, 0]))
  await resolveSkills({})
  await expect(readSkillFileEntry(dir, '../outside')).rejects.toThrow('path escapes')
  expect((await readSkillFileEntry(dir, 'limit.txt')).binary).toBe(false)
  expect(await readSkillFileEntry(dir, 'large.txt')).toEqual({
    content: null,
    binary: true,
    size: 2 * 1024 * 1024 + 1,
  })
  expect(await readSkillFileEntry(dir, 'binary')).toEqual({ content: null, binary: true, size: 2 })
})

it('caps the sorted walk at 500 files and excludes hidden directories and node_modules', async () => {
  const dir = await seed('many')
  for (const child of ['.hidden', 'node_modules', 'nested']) {
    await mkdir(join(dir, child))
    await writeFile(join(dir, child, 'ignored.txt'), 'nested')
  }
  await Promise.all(
    Array.from({ length: 501 }, (_, index) =>
      writeFile(join(dir, `${String(index).padStart(3, '0')}.txt`), 'x'),
    ),
  )
  const skill = (await resolveSkills({})).skills[0]!
  expect(skill.files).toHaveLength(500)
  expect(skill.files[0]?.path).toBe('000.txt')
  expect(skill.files[499]?.path).toBe('499.txt')
  expect(skill.totalSize).toBe(500)
})
