import type * as CliOpsModule from './cli-ops'
import { describe, expect, it, vi } from 'vitest'
import { readCliRequest } from './cli-args'
import { runCli, USAGE, type CliContext } from './cli'
import { runCliOps } from './cli-ops'

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
  it.each([[['lane', 'list']], [['serve', '--json']], [['--config', '/c.json', 'artifact']]])(
    'routes %j to the ops CLI, which still answers unknown command',
    async (argv) => {
      vi.mocked(runCliOps).mockClear()
      const result = await cli(argv)
      expect(runCliOps).toHaveBeenCalledOnce()
      expect(result.code).toBe(64)
      expect(result.stderr).toMatch(/^phosphor: unknown command "/)
    },
  )

  it.each([[['version']], [['help']], [['--help']], [[]], [['doctor', '--bogus']]])(
    'keeps %j on the command table',
    async (argv) => {
      vi.mocked(runCliOps).mockClear()
      await cli(argv)
      expect(runCliOps).not.toHaveBeenCalled()
    },
  )

  it('answers help through the ops CLI as the command table does', async () => {
    expect(await cli(['lane', '--help'])).toEqual({ code: 0, stdout: USAGE, stderr: '' })
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
