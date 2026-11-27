import type * as CliOpsModule from './cli-ops'
import { describe, expect, it, vi } from 'vitest'
import { LANE_WAIT_DEADLINE_MS, type OpRequestEnvelope } from '@phosphor/shared/ops'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import { readCliRequest } from './cli-args'
import { runCli, type CliContext } from './cli'
import { runCliOps } from './cli-ops'
import { openLocalClient } from './local-client'

vi.mock('./local-client', () => ({
  openLocalClient: vi.fn(() => {
    throw new Error('No local socket')
  }),
}))

vi.mock('./cli-ops', async (original) => {
  const actual = await original<typeof CliOpsModule>()
  return { ...actual, runCliOps: vi.fn(actual.runCliOps) }
})

const context = {
  env: {},
  platform: 'linux',
  uid: 501,
  home: '/home/bee',
  hostname: 'bee1',
  nodeVersion: '22.22.3',
  defaultResourceRoot: '/resources',
  runInTerminal: async () => ({ code: 0 }),
  tailscale: { which: async () => null, probe: vi.fn() },
  control: { now: () => 1 },
} as unknown as CliContext

async function cli(argv: string[]) {
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (t) => void (out.stdout += t), stderr: (t) => void (out.stderr += t) },
    context,
  )
  return { code, ...out }
}

describe('catalog ops routing', () => {
  it.each([[['serve', '--json']], [['--config', '/c.json', 'artifact']]])(
    'routes %j to the ops CLI, which still answers unknown command',
    async (argv) => {
      vi.mocked(runCliOps).mockClear()
      const result = await cli(argv)
      expect(runCliOps).toHaveBeenCalledOnce()
      expect(result.code).toBe(64)
      expect(result.stderr).toMatch(/^phosphor: Unknown domain or command/)
    },
  )

  it.each([[['version']], [['--help']], [[]], [['doctor', '--bogus']]])(
    'keeps %j on the command table',
    async (argv) => {
      vi.mocked(runCliOps).mockClear()
      await cli(argv)
      expect(runCliOps).not.toHaveBeenCalled()
    },
  )

  it('keeps catalog help offline and lists its domains alongside the fixed commands', async () => {
    expect((await cli(['help'])).stdout).toContain('Domains:')
    expect((await cli(['help', 'lane'])).stdout).toContain('lane.read:')
  })

  it('shows a catalog domain for domain --help', async () => {
    expect(await cli(['lane', '--help'])).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('lane.read:'),
      stderr: '',
    })
  })
})

describe('local setup and staged update flags', () => {
  const usage = (problem: string) => ({ kind: 'usage', problem })
  const owner = ['--owner-id', 'id', '--owner-key', 'key', '--owner-label', 'Mac']
  it.each([
    [
      ['setup', '--local', ...owner, '--replace'],
      'setup --local does not take --repository or --replace',
    ],
    [['setup', '--local'], 'setup --local needs --owner-id, --owner-key and --owner-label'],
    [['setup', '--linger'], 'setup does not take --linger without --local'],
    [['setup', ...owner], 'setup does not take --owner-id without --local'],
    [['update', '--stage', '--apply', '1.2.3'], 'invalid update options'],
    [['update', '--apply', 'latest'], 'invalid update options'],
    [['update', '--stage', '--check'], 'invalid update options'],
    [['doctor', '--stage'], 'doctor does not take --stage'],
  ])('refuses %j: %s', (argv, problem) => {
    expect(readCliRequest(argv, false)).toEqual(usage(problem))
  })

  it('reads update --stage and --apply as update commands', () => {
    expect(readCliRequest(['update', '--stage', '--json'], false)).toMatchObject({
      kind: 'command',
      command: { name: 'update', options: { stage: true, json: true } },
    })
    expect(readCliRequest(['update', '--apply', '1.2.3'], false)).toMatchObject({
      kind: 'command',
      command: { name: 'update', options: { apply: '1.2.3' } },
    })
  })

  it('leaves setup and update without the new flags unchanged', () => {
    expect(readCliRequest(['setup'], false)).toMatchObject({ kind: 'command' })
    expect(readCliRequest(['update', '--check'], false)).toMatchObject({ kind: 'command' })
  })
})

it('asks the local owner for all catalog help forms and routes the service update op', async () => {
  const run = vi.fn(async () => ({
    status: 'ok' as const,
    text: 'owner reply',
    applies: 'now' as const,
  }))
  const close = vi.fn()
  vi.mocked(openLocalClient).mockReturnValue({ run, runBrain: vi.fn(), close })
  for (const args of [
    ['help', 'lane', 'read'],
    ['help', 'lane.read'],
    ['lane', 'read', '--help'],
  ])
    expect(await cli(args)).toEqual({ code: 0, stdout: 'owner reply\n', stderr: '' })
  expect(await cli(['help'])).toMatchObject({ stdout: 'owner reply\n' })
  expect(await cli(['service', 'update'])).toMatchObject({ stdout: 'owner reply\n' })
  expect(await cli(['service.update'])).toMatchObject({ stdout: 'owner reply\n' })
  expect(run.mock.calls).toEqual([
    ...Array.from({ length: 3 }, () => [expect.objectContaining({ argv: ['help', 'lane.read'] })]),
    [expect.objectContaining({ argv: ['help'] })],
    [expect.objectContaining({ argv: ['service', 'update'] })],
    [expect.objectContaining({ argv: ['service.update'] })],
  ])
  expect(close).toHaveBeenCalledTimes(6)
})

it('keeps ordinary CLI envelopes compatible with the old owner’s deadline ceiling', async () => {
  const run = vi.fn(async (request: OpRequestEnvelope) => {
    const [domain, verb] = request.argv ?? []
    const wait = domain === 'lane.wait' || (domain === 'lane' && verb === 'wait')
    const oldOwnerLimit = wait ? LANE_WAIT_DEADLINE_MS : 600_000
    if (request.deadlineMs > oldOwnerLimit) throw new Error('Invalid operation request')
    return { status: 'ok' as const, text: 'owner reply', applies: 'now' as const }
  })
  for (const args of [['lane', 'list'], ['lane', 'wait'], ['lane.wait']]) {
    vi.mocked(openLocalClient).mockReturnValueOnce({ run, runBrain: vi.fn(), close: vi.fn() })
    expect(await cli(args)).toMatchObject({ code: 0, stdout: 'owner reply\n' })
  }
  expect(run.mock.calls.map(([request]) => request.deadlineMs)).toEqual([
    600_000,
    LANE_WAIT_DEADLINE_MS,
    LANE_WAIT_DEADLINE_MS,
  ])
})

it('reserves the longer CLI backstop for the only catalog op over 600 seconds', () => {
  expect(
    OP_CATALOG.filter((spec) => (spec.deadlineMs ?? 0) > 600_000).map(({ name }) => name),
  ).toEqual(['lane.wait'])
})

it('labels offline help as static and keeps an unknown domain error short', async () => {
  vi.mocked(openLocalClient).mockImplementation(() => {
    throw new Error('No local socket')
  })
  expect(await cli(['help', 'lane.read'])).toMatchObject({
    stdout: expect.stringMatching(/^Static catalog/),
  })
  const unknown = await cli(['lan', 'read'])
  expect(unknown.stderr).toContain('Did you mean lane?')
  expect(unknown.stderr).toContain('phosphor help')
  expect(unknown.stderr.length).toBeLessThan(200)
})

describe('the brain domain', () => {
  const ok = { status: 'ok' as const, text: 'owner reply', applies: 'now' as const }

  it('keeps lane recall on the catalog and sends every other brain command to the private Brain CLI', async () => {
    const run = vi.fn(async () => ok)
    const runBrain = vi.fn(async () => ({ ...ok, data: { counts: {} } }))
    vi.mocked(openLocalClient).mockReturnValue({ run, runBrain, close: vi.fn() })
    expect(await cli(['brain', 'search', 'Harbor'])).toMatchObject({ code: 0 })
    expect(await cli(['brain', 'flag', '1', 'wrong', 'stale'])).toMatchObject({ code: 0 })
    expect(run.mock.calls).toEqual([
      [expect.objectContaining({ argv: ['brain', 'search', 'Harbor'] })],
      [expect.objectContaining({ argv: ['brain', 'flag', '1', 'wrong', 'stale'] })],
    ])
    expect(runBrain).not.toHaveBeenCalled()
    expect(await cli(['brain', 'status'])).toMatchObject({ code: 0 })
    expect(runBrain).toHaveBeenCalledExactlyOnceWith(
      { op: BRAIN_SURFACE, args: { method: 'brain:status', args: [] } },
      false,
    )
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('answers Brain help offline in every spelling, and leaves lane recall help to the catalog', async () => {
    vi.mocked(openLocalClient).mockClear()
    vi.mocked(openLocalClient).mockImplementation(() => {
      throw new Error('No local socket')
    })
    for (const argv of [['brain'], ['brain', '--help'], ['brain', 'help'], ['help', 'brain']]) {
      const result = await cli(argv)
      expect(result, argv.join(' ')).toMatchObject({ code: 0, stderr: '' })
      expect(result.stdout).toContain('phosphor brain queue <lane-id>')
      expect(result.stdout).not.toContain('--host')
    }
    for (const argv of [
      ['brain', 'queue', '--help'],
      ['help', 'brain', 'queue'],
      ['help', 'brain.queue'],
    ])
      expect((await cli(argv)).stdout, argv.join(' ')).toMatch(/^Usage: phosphor brain queue/)
    expect(openLocalClient).not.toHaveBeenCalled()
    expect((await cli(['help', 'brain', 'search'])).stdout).toMatch(/^Static catalog/)
  })

  it('refuses another Host and an unknown Brain command as usage errors, contacting nothing', async () => {
    vi.mocked(openLocalClient).mockClear()
    expect(await cli(['brain', 'status', '--host', 'all'])).toMatchObject({
      code: 64,
      stdout: '',
      stderr: expect.stringContaining('this Host only'),
    })
    expect(await cli(['brain', 'fly'])).toMatchObject({
      code: 64,
      stderr: expect.stringContaining('phosphor brain --help'),
    })
    expect(openLocalClient).not.toHaveBeenCalled()
  })
})
