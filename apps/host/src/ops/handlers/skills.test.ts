import { mkdtemp, mkdir, rm, symlink, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { skillHandlers } from './skills'
import type { DaemonHandlerDeps } from './index'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'

vi.mock('@phosphor/session-runtime/skills/catalog', () => ({
  resolveCatalogBundle: async () => ({
    bundle: [{ rel: 'SKILL.md', data: Buffer.from('catalog') }],
  }),
}))
const agent = {
  kind: 'agent',
  laneRef: 'host:self/lane:one',
  sessionId: 'one',
  unattended: false,
  lineage: 0,
} as const
const surface = { kind: 'surface', clientId: 'desktop', label: 'Desktop', via: 'owner' } as const
let base: string, repo: string, agentDir: string
const target = { name: 'demo', scope: 'project' }
function fixture() {
  const call = vi.fn(async () => ({ ok: true, data: { skills: [] } }))
  const resourceChanged = vi.fn()
  const handlers = skillHandlers({
    store: { listRepositories: () => [{ path: repo }] },
    lanes: { calls: { call } },
    skills: {
      agentDir,
      context: { home: base, env: {}, resourceChanged },
      resolveProject: async () => [],
    },
  } as unknown as DaemonHandlerDeps)
  const ctx: Omit<OpHandlerContext, 'principal'> = {
    lane: {
      ref: 'host:self/lane:one',
      cwd: repo,
      sessionId: 'one',
      title: 'Issuer',
      busy: false,
      controller: null,
    },
    signal: new AbortController().signal,
    log: () => {},
  }
  return {
    call,
    resourceChanged,
    run: (name: string, args: unknown, principal: OpHandlerContext['principal'] = agent) =>
      handlers[name]!(args, { ...ctx, principal }),
  }
}
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'ops-skills-')))
  repo = join(base, 'repo')
  agentDir = join(base, 'pi')
  await mkdir(repo)
  await mkdir(agentDir)
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})
it('creates and edits only the selected writable skill, never returning its old content', async () => {
  const { run } = fixture()
  await run('skill.create', { ...target, description: 'Demo', content: 'initial', draft: true })
  const path = join(repo, '.pi', 'skills', 'demo', 'SKILL.md')
  expect(await readFile(path, 'utf8')).toContain('disable-model-invocation: true')
  const result = await run('skill.edit', { ...target, content: 'new' })
  expect(result.before).toBeUndefined()
  expect(result.text).toContain('No Undo:')
  expect(await readFile(path, 'utf8')).toBe('new')
  await run('skill.delete', target)
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('refuses escaping folder links, provenance edits and a project outside configured roots', async () => {
  const { run } = fixture()
  await symlink(agentDir, join(repo, '.pi'))
  await expect(run('skill.create', { ...target, description: 'No' })).rejects.toThrow()
  await expect(stat(join(agentDir, 'skills'))).rejects.toThrow()
  await expect(
    run('skill.edit', { ...target, file: '.PHOSPHOR-SKILL.JSON', content: 'no' }),
  ).rejects.toThrow()
  await expect(
    run('skill.create', { ...target, description: 'No', project: base }),
  ).rejects.toThrow('configured project')
})
it('resolves reads against only the asking lane through the Host feature', async () => {
  const { call, run } = fixture()
  await run('skill.read', { name: 'demo' })
  expect(call).toHaveBeenCalledExactlyOnceWith(
    'skills.read',
    { laneId: 'one', name: 'demo' },
    expect.any(Function),
    undefined,
    expect.any(AbortSignal),
  )
})

it('keeps a bundle unchanged when a second create collides with it', async () => {
  const { run } = fixture()
  await run('skill.create', { ...target, description: 'First', content: 'Keep me' })
  await expect(
    run('skill.create', { ...target, description: 'Second', content: 'Replace me' }),
  ).rejects.toThrow('already exists')
  expect(await readFile(join(repo, '.pi/skills/demo/SKILL.md'), 'utf8')).toContain('Keep me')
})

it.each([agent, surface])(
  'invalidates Skills once after a global edit by $kind',
  async (principal) => {
    const { run, resourceChanged } = fixture()
    const user = { ...target, scope: 'user' }
    await run('skill.create', { ...user, description: 'Demo' })
    resourceChanged.mockClear()
    await run('skill.edit', { ...user, content: 'edited' }, principal)
    expect(await readFile(join(agentDir, 'skills/demo/SKILL.md'), 'utf8')).toBe('edited')
    expect(resourceChanged).toHaveBeenCalledExactlyOnceWith({ kind: 'skills' })
  },
)

it('invalidates Skills after each agent create, delete and project install, but not a conflict', async () => {
  const { run, resourceChanged } = fixture()
  for (const [name, args] of [
    ['skill.create', { ...target, description: 'Demo' }],
    ['skill.delete', target],
    ['skill.install', { ...target, libraryId: 'fixture' }],
  ] as const) {
    resourceChanged.mockClear()
    await run(name, args)
    expect(resourceChanged).toHaveBeenCalledExactlyOnceWith({ kind: 'skills' })
  }
  expect(await readFile(join(repo, '.pi/skills/demo/SKILL.md'), 'utf8')).toBe('catalog')
  resourceChanged.mockClear()
  await expect(run('skill.install', { ...target, libraryId: 'fixture' })).rejects.toThrow(
    'already exists',
  )
  expect(resourceChanged).not.toHaveBeenCalled()
})
