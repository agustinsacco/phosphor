import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { probeCommandsCached } from '../commands'
import { packageSkillDirs } from '../packages'
import { resolveSkills } from './discovery'

vi.mock('../commands', () => ({ probeCommandsCached: vi.fn() }))
vi.mock('../packages', () => ({ packageSkillDirs: vi.fn() }))
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-discovery-'))
  vi.stubEnv('PI_CODING_AGENT_DIR', join(root, 'agent'))
  vi.mocked(probeCommandsCached).mockReset().mockRejectedValue(new Error('probe failed'))
  vi.mocked(packageSkillDirs).mockReset().mockResolvedValue([])
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function seed(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nbody`)
}

it('falls back after probe failure and expands settings paths relative to each settings directory', async () => {
  const agent = join(root, 'agent')
  const project = join(root, 'workspace', '.pi')
  await seed(join(agent, 'custom'), 'user-listed')
  await seed(join(project, 'custom'), 'project-listed')
  await seed(join(root, 'absolute'), 'absolute-listed')
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ skills: ['custom', join(root, 'absolute'), 42] }),
  )
  await writeFile(join(project, 'settings.json'), JSON.stringify({ skills: ['custom'] }))
  const result = await resolveSkills({
    binaryPath: '/missing',
    workspacePath: join(root, 'workspace'),
  })
  expect(result.probe).toBe('scan')
  expect(result.skills.map((skill) => [skill.name, skill.scope, skill.writable])).toEqual([
    ['absolute-listed', 'user', false],
    ['project-listed', 'project', false],
    ['user-listed', 'user', false],
  ])
  expect(packageSkillDirs).toHaveBeenCalledWith(join(root, 'workspace'))
})

it('deduplicates package discoveries after scan entries and ignores unreadable or malformed settings', async () => {
  const dir = join(root, 'agent', 'skills', 'local')
  const pkg = join(root, 'package')
  await seed(dir, 'local')
  await seed(pkg, 'package')
  await writeFile(join(root, 'agent', 'settings.json'), '{broken')
  vi.mocked(packageSkillDirs).mockResolvedValue([
    { dir, scope: 'user', source: 'duplicate' },
    { dir: pkg, scope: 'project', source: 'npm:demo' },
    { dir: join(root, 'missing'), scope: 'user', source: 'npm:missing' },
  ])
  const result = await resolveSkills({})
  expect(
    result.skills.map((skill) => [skill.name, skill.source, skill.origin, skill.writable]),
  ).toEqual([
    ['local', 'scan', 'top-level', true],
    ['package', 'npm:demo', 'package', false],
  ])
  expect(probeCommandsCached).not.toHaveBeenCalled()
})

it('expands home settings entries and stops scanning below depth four or excluded directories', async () => {
  const agent = join(root, 'agent')
  await seed(join(agent, 'skills', 'a', 'b', 'c', 'd'), 'depth-four')
  await seed(join(agent, 'skills', 'a', 'b', 'c', 'd', 'e'), 'too-deep')
  await seed(join(agent, 'skills', '.hidden'), 'hidden')
  await seed(join(agent, 'skills', 'node_modules'), 'modules')
  await seed(join(root, 'home-listed'), 'home-listed')
  const homeRelative = `~/${relative(homedir(), join(root, 'home-listed'))}`
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ skills: [homeRelative] }))
  const result = await resolveSkills({})
  expect(result.skills.map((skill) => skill.name)).toEqual(['depth-four', 'home-listed'])
})
