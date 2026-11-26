import { mkdtemp, mkdir, rm, symlink, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { skillHandlers } from './skills'
import type { DaemonHandlerDeps } from './index'
let base: string, repo: string, agentDir: string
const target = { name: 'demo', scope: 'project' }
function fixture() {
  const call = vi.fn(async () => ({ ok: true, data: { skills: [] } }))
  const handlers = skillHandlers({
    store: { listRepositories: () => [{ path: repo }] },
    lanes: { calls: { call } },
    skills: { agentDir, context: { home: base, env: {} } },
  } as unknown as DaemonHandlerDeps)
  const ctx = {
    lane: { ref: 'host:self/lane:one', cwd: repo },
    signal: new AbortController().signal,
  } as never
  return { call, run: (name: string, args: unknown) => handlers[name]!(args, ctx) }
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
  await expect(run('skill.create', { ...target, description: 'Second', content: 'Replace me' }))
    .rejects.toThrow('already exists')
  expect(await readFile(join(repo, '.pi/skills/demo/SKILL.md'), 'utf8')).toContain('Keep me')
})
