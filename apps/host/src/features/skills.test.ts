vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: async () => [] }))
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { HostInspection } from '../commands/doctor'
import type { StoredLane } from '../lanes/store'
import type { FeatureContext, HostFeature } from './feature'
import { createSkillsFeature } from './skills'
import { INSPECTION_DEADLINE_MS } from './machine'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fsPromises>()
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    open: vi.fn(actual.open),
    realpath: vi.fn(actual.realpath),
  }
})

let root: string
let repo: string
let bundle: string
let commands: unknown[]
let models: unknown[]
let feature: HostFeature
let removed = false
let active = true
let cwd: string
let payload: string | undefined
const laneId = randomUUID()
const model = { id: 'model', name: 'Model', provider: 'provider', reasoning: true }
const command = (path: string, scope = 'user') => ({
  name: 'skill:demo',
  description: 'Example',
  source: 'skill',
  sourceInfo: { path, scope },
})
const lane = (): StoredLane => ({
  laneId,
  repositoryId: 'a'.repeat(16),
  cwd,
  sessionFile: null,
  removedAt: removed ? new Date().toISOString() : null,
  title: null,
  branch: null,
  worktree: false,
  activity: 'idle',
  model: null,
  createdAt: new Date().toISOString(),
  control: { fence: 1, controller: null },
  updatedAt: new Date().toISOString(),
  attention: 0,
  read: 0,
})
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-skills-'))
  repo = join(root, 'repo')
  await mkdir(repo)
  execFileSync('git', ['init', '-q', repo])
  cwd = repo
  bundle = join(root, 'global', 'demo')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'SKILL.md'), 'global')
  models = [model]
  commands = [command(join(bundle, 'SKILL.md'))]
  removed = false
  active = true
  payload = undefined
  const script = join(root, 'pi.cjs')
  await writeFile(
    script,
    `let text='';process.stdin.on('data', c=>text+=c);process.stdin.on('data',()=>{if(!text.includes('\\n'))return;const q=JSON.parse(text);const data=q.type==='get_commands'?{commands:JSON.parse(process.env.COMMANDS)}:{models:JSON.parse(process.env.MODELS)}; console.log((process.env.PAYLOAD?require('node:fs').readFileSync(process.env.PAYLOAD,'utf8'):undefined)||JSON.stringify({type:'response',id:q.id,success:true,data}));});`,
  )
  const context: FeatureContext = {
    home: root,
    env: {},
    log: () => {},
    store: {
      getLane: (id) => (id === laneId ? lane() : null),
      listRepositories: () => (active ? [{ id: 'a'.repeat(16), name: 'repo', path: repo }] : []),
    },
  }
  feature = createSkillsFeature(context, {
    inspect: async (): Promise<HostInspection> => {
      if (payload) await writeFile(join(root, 'payload'), payload)
      return {
        report: {
          ok: true,
          exitCode: 0,
          host: { version: '1', node: '24', platform: 'linux' },
          config: { path: '' },
          checks: [],
          lanes: { native: { available: true }, claude: { available: false } },
          providers: [
            { id: 'provider', name: 'Provider', status: 'ready', reason: 'private diagnostic' },
          ],
        },
        machine: null,
        secrets: [],
        piVersion: '1',
        claude: null,
        pi: {
          launch: { binaryPath: process.execPath, prefixArgs: [script], version: '1' },
          environment: {
            env: {
              COMMANDS: JSON.stringify(commands),
              MODELS: JSON.stringify(models),
              ...(payload ? { PAYLOAD: join(root, 'payload') } : {}),
            },
            secrets: [],
            names: [],
            ambient: [],
            unset: [],
          },
        },
      }
    },
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const read = (params: unknown = { name: 'demo' }) => feature.call('skills.read', params)
const error = (code: string) => ({
  ok: false,
  error: {
    code,
    message:
      code === 'bad-request'
        ? 'Invalid feature request.'
        : code === 'unknown-lane'
          ? 'Unknown lane.'
          : code === 'too-large'
            ? 'Feature result exceeds its limit.'
            : 'Feature unavailable.',
  },
})
describe('createSkillsFeature', () => {
  it('rejects methods outside the allowlist', async () => {
    expect(await feature.call('machine.execute', {})).toEqual(error('unsupported'))
  })
  it('reads the Host catalogue, projects metadata and rejects caller executable/environment', async () => {
    models = [{ ...model, credential: 'private', contextWindow: 200000 }]
    expect(await feature.call('machine.models', {})).toEqual({
      ok: true,
      data: { models: [{ ...model, contextWindow: 200000 }], source: 'pi' },
    })
    for (const params of [{ binaryPath: '/bin/sh' }, { env: {} }, { laneId }])
      expect(await feature.call('machine.models', params)).toEqual(error('bad-request'))
  })
  it('returns only provider names and readiness, not diagnostics or credentials', async () => {
    expect(await feature.call('machine.providers', {})).toEqual({
      ok: true,
      data: {
        providers: [
          { id: 'provider', name: 'Provider', status: 'ready' },
          { id: 'pi-claude-cli', name: 'Claude CLI', status: 'not_ready' },
        ],
      },
    })
  })
  it('is stateless and project skills win over global skills', async () => {
    const project = join(repo, '.pi', 'skills', 'demo')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'SKILL.md'), 'project')
    commands.push(command(join(project, 'SKILL.md'), 'project'))
    expect(await feature.call('skills.list', { laneId })).toEqual({
      ok: true,
      data: { skills: [{ name: 'demo', description: 'Example', scope: 'project' }] },
    })
    expect(await read({ name: 'demo', laneId })).toEqual({
      ok: true,
      data: { binary: false, size: 7, content: 'project' },
    })
    expect(await read()).toEqual({ ok: true, data: { binary: false, size: 6, content: 'global' } })
    commands.reverse()
    expect(await read({ name: 'demo', laneId })).toEqual({
      ok: true,
      data: { binary: false, size: 7, content: 'project' },
    })
  })
  it.each(['../x', '/etc/passwd', 'a/../x', '.git/config', 'a\0b', 'a\\b'])(
    'refuses path %s',
    async (file) => {
      expect(await read({ name: 'demo', file })).toEqual(error('bad-request'))
    },
  )
  it('rejects unknown names and non-regular files', async () => {
    expect(await read({ name: 'unknown' })).toEqual(error('bad-request'))
    await mkdir(join(bundle, 'folder'))
    expect(await read({ name: 'demo', file: 'folder' })).toEqual(error('bad-request'))
  })
  it('never reads a non-regular descriptor', async () => {
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises')
    const didRead = vi.fn()
    vi.mocked(fsPromises.open).mockImplementation(async (path, flags) => {
      const fd = await actual.open(path, flags)
      vi.spyOn(fd, 'read').mockImplementation(async () => {
        didRead()
        throw new Error('read refused')
      })
      return fd
    })
    await mkdir(join(bundle, 'dir'))
    expect(await read({ name: 'demo', file: 'dir' })).toEqual(error('bad-request'))
    expect(didRead).not.toHaveBeenCalled()
    vi.mocked(fsPromises.open).mockImplementation(actual.open)
  })
  it('rejects both file and parent symlink escapes', async () => {
    await writeFile(join(root, 'outside'), 'private')
    await symlink(join(bundle, 'SKILL.md'), join(bundle, 'inside-link'))
    expect(await read({ name: 'demo', file: 'inside-link' })).toEqual(error('bad-request'))
    await symlink(join(root, 'outside'), join(bundle, 'link'))
    await symlink(root, join(bundle, 'parent'))
    expect(await read({ name: 'demo', file: 'link' })).toEqual(error('bad-request'))
    expect(await read({ name: 'demo', file: 'parent/outside' })).toEqual(error('bad-request'))
  })
  it('rechecks descriptor identity and rejects aliases into .git', async () => {
    const originalStat = (await vi.importActual<typeof fsPromises>('node:fs/promises')).stat
    vi.mocked(fsPromises.stat).mockImplementation(async (path) => {
      const info = await originalStat(path)
      info.ino += 1
      return info
    })
    expect(await read()).toEqual(error('bad-request'))
    vi.mocked(fsPromises.stat).mockImplementation(originalStat)
    await mkdir(join(bundle, '.git'))
    await writeFile(join(bundle, '.git', 'config'), 'private')
    await symlink(join(bundle, '.git'), join(bundle, 'alias'))
    expect(await read({ name: 'demo', file: 'alias/config' })).toEqual(error('bad-request'))
  })
  it('rejects project skill paths outside the lane', async () => {
    commands = [command(join(bundle, 'SKILL.md'), 'project')]
    expect(await read({ name: 'demo', laneId })).toEqual(error('bad-request'))
    expect(await feature.call('skills.list', { laneId })).toEqual(error('bad-request'))
  })
  it('rejects unknown, removed, inactive-repository and escaped lanes', async () => {
    expect(await read({ name: 'demo', laneId: randomUUID() })).toEqual(error('unknown-lane'))
    removed = true
    expect(await read({ name: 'demo', laneId })).toEqual(error('unknown-lane'))
    removed = false
    active = false
    vi.mocked(fsPromises.realpath).mockClear()
    expect(await read({ name: 'demo', laneId })).toEqual(error('unknown-lane'))
    expect(fsPromises.realpath).not.toHaveBeenCalled()
    active = true
    cwd = root
    expect(await read({ name: 'demo', laneId })).toEqual(error('unknown-lane'))
  })
  it('caps text at exactly 2 MiB and labels binary files', async () => {
    await writeFile(join(bundle, 'large'), Buffer.alloc(2 * 1024 * 1024, 65))
    const atLimit = await read({ name: 'demo', file: 'large' })
    expect(atLimit.ok).toBe(true)
    await writeFile(join(bundle, 'large'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))
    expect(await read({ name: 'demo', file: 'large' })).toEqual(error('too-large'))
    await writeFile(join(bundle, 'binary'), Buffer.from([0, 1, 2]))
    await writeFile(join(bundle, 'invalid-utf8'), Buffer.from([255]))
    expect(await read({ name: 'demo', file: 'invalid-utf8' })).toEqual({
      ok: true,
      data: { binary: true, size: 1 },
    })
    expect(await read({ name: 'demo', file: 'binary' })).toEqual({
      ok: true,
      data: { binary: true, size: 3 },
    })
  })
  it('bounds reads when a file grows after fstat', async () => {
    const actual = await vi.importActual<typeof fsPromises>('node:fs/promises')
    vi.mocked(fsPromises.open).mockImplementation(async (path, flags) => {
      const fd = await actual.open(path, flags)
      const original = fd.stat.bind(fd)
      vi.spyOn(fd, 'stat').mockImplementation(async () => {
        const info = await original()
        await actual.appendFile(path, 'extra')
        return info
      })
      return fd
    })
    expect(await read()).toEqual(error('too-large'))
    vi.mocked(fsPromises.open).mockImplementation(actual.open)
  })
  it('caps models at 1000 and skills at 500, without silent truncation', async () => {
    models = Array.from({ length: 1000 }, () => model)
    expect((await feature.call('machine.models', {})).ok).toBe(true)
    models.push(model)
    expect(await feature.call('machine.models', {})).toEqual(error('too-large'))
    commands = Array.from({ length: 500 }, () => command(join(bundle, 'SKILL.md')))
    expect((await feature.call('skills.list', {})).ok).toBe(true)
    commands.push(command(join(bundle, 'SKILL.md')))
    expect(await feature.call('skills.list', {})).toEqual(error('too-large'))
    commands = Array.from({ length: 2001 }, () => ({ source: 'extension' }))
    expect(await feature.call('skills.list', {})).toEqual(error('too-large'))
  })
  it('rejects oversize child output and malformed or failed responses with fixed errors', async () => {
    payload = 'x'.repeat(2 * 1024 * 1024 + 1)
    expect(await feature.call('machine.models', {})).toEqual(error('too-large'))
    payload = 'private invalid output'
    expect(await feature.call('machine.models', {})).toEqual(error('internal'))
    payload = JSON.stringify({ id: 'feature', type: 'response', success: false, error: 'private' })
    expect(await feature.call('machine.models', {})).toEqual(error('internal'))
  })
  it('releases the queue when an inspection never settles', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    let calls = 0
    const stalled = createSkillsFeature(
      {
        home: root,
        env: {},
        log: () => {},
        store: { getLane: () => null, listRepositories: () => [] },
      },
      {
        inspect: () =>
          calls++ === 0 ? new Promise<never>(() => {}) : Promise.reject(new Error('x')),
      },
    )
    const first = stalled.call('machine.providers', {})
    const second = stalled.call('machine.models', {})
    await vi.advanceTimersByTimeAsync(INSPECTION_DEADLINE_MS)
    expect(await first).toEqual(error('internal'))
    expect(await second).toEqual(error('internal'))
    expect(calls).toBe(2)
  })
  it('never runs two probes at once', async () => {
    let inFlight = 0
    let peak = 0
    const serial = createSkillsFeature(
      {
        home: root,
        env: {},
        log: () => {},
        store: { getLane: () => null, listRepositories: () => [] },
      },
      {
        inspect: async () => {
          peak = Math.max(peak, ++inFlight)
          await new Promise((r) => setTimeout(r, 10))
          inFlight--
          throw new Error('probe')
        },
      },
    )
    await Promise.all([serial.call('machine.models', {}), serial.call('machine.providers', {})])
    expect(peak).toBe(1)
  })
  it('queues concurrent probes instead of failing them, with a bounded queue', async () => {
    const both = await Promise.all([
      feature.call('machine.models', {}),
      feature.call('machine.providers', {}),
    ])
    expect(both.map((r) => r.ok)).toEqual([true, true])
    const burst = await Promise.all(
      Array.from({ length: 9 }, () => feature.call('machine.models', {})),
    )
    expect(burst.filter((r) => r.ok)).toHaveLength(8)
    expect(burst.filter((r) => !r.ok)).toEqual([error('internal')])
  })
})

it('serves machine.claude under the existing read capability with strict empty params', async () => {
  expect(feature.capability).toBe('skills.read')
  expect(feature.methods).toContain('machine.claude')
  expect(await feature.call('machine.claude', {})).toEqual({
    ok: true,
    data: { provider: 'missing', cli: 'missing', auth: 'unknown' },
  })
  expect(await feature.call('machine.claude', { extra: true })).toEqual(error('bad-request'))
})
