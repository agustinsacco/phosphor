import type * as CliOpsModule from './cli-ops'
import { describe, expect, it, vi } from 'vitest'
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
  vi.mocked(openLocalClient).mockReturnValue({ run, close })
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
