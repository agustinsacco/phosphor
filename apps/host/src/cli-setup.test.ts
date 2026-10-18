import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as GuidedSetup from './commands/guided-setup'
import type * as Setup from './commands/setup'
import type * as Identity from './control/identity'
import { identityDirectory } from './control/identity'
import type { CliOptions } from './cli-args'
import type { CliContext, CommandOf } from './cli-handlers'
import type { Drainable } from './shutdown'
import { handleSetup } from './cli-setup'

const m = vi.hoisted(() => ({
  runSetup: vi.fn(),
  runGuidedSetup: vi.fn(),
  load: vi.fn(),
  createIdentityStore: vi.fn(),
}))
vi.mock('./commands/setup', async (original) => ({
  ...(await original<typeof Setup>()),
  runSetup: m.runSetup,
  renderSetup: (report: unknown) => `setup ${JSON.stringify(report)}\n`,
}))
vi.mock('./commands/guided-setup', async (original) => ({
  ...(await original<typeof GuidedSetup>()),
  runGuidedSetup: m.runGuidedSetup,
}))
vi.mock('./control/identity', async (original) => ({
  ...(await original<typeof Identity>()),
  createIdentityStore: m.createIdentityStore,
}))

afterEach(() => {
  vi.clearAllMocks()
})

function setup(terminal: boolean) {
  const out = { stdout: '', stderr: '' }
  const targets: Drainable[] = []
  let detached = 0
  m.createIdentityStore.mockReturnValue({ load: m.load })
  const context: CliContext = {
    env: {},
    platform: 'linux',
    uid: 501,
    home: '/home/bee',
    hostname: 'bee1',
    nodeVersion: '22.22.3',
    defaultResourceRoot: '/resources',
    cwd: '/work',
    terminal,
    control: { fetch: vi.fn() },
    attach: (target) => {
      targets.push(target)
      return () => void detached++
    },
  }
  const io = {
    stdout: (text: string) => void (out.stdout += text),
    stderr: (text: string) => void (out.stderr += text),
  }
  return { out, targets, detached: () => detached, context, io }
}
const command = (options: CliOptions = {}): CommandOf<'setup'> => ({
  name: 'setup',
  repositories: ['a'],
  options: { config: '/c.json', ...options },
})

describe('setup without a terminal', () => {
  it.each([
    [null, 0, { exitCode: 0, next: 'phosphor login' }],
    [{ id: 'host' }, 0, { exitCode: 0 }],
    [new Error('unreadable'), 0, { exitCode: 0, next: 'phosphor login' }],
    [null, 78, { exitCode: 78 }],
  ])(
    'writes the config only and points at login (identity %j, exit %i)',
    async (loaded, exitCode, report) => {
      const { out, targets, context, io } = setup(false)
      m.runSetup.mockResolvedValue({ exitCode })
      if (loaded instanceof Error) m.load.mockRejectedValue(loaded)
      else m.load.mockResolvedValue(loaded)
      expect(await handleSetup(command(), io, context)).toBe(exitCode)
      expect(out).toEqual({ stdout: `setup ${JSON.stringify(report)}\n`, stderr: '' })
      expect(m.runSetup.mock.calls[0]![0]).toMatchObject({
        cwd: '/work',
        configPath: '/c.json',
        repositories: ['a'],
        tailscaleHints: false,
      })
      expect(m.createIdentityStore.mock.calls[0]).toEqual([
        identityDirectory('/c.json'),
        process.getuid?.(),
      ])
      expect(m.runGuidedSetup).not.toHaveBeenCalled()
      expect(context.control?.fetch).not.toHaveBeenCalled()
      expect(targets).toEqual([])
    },
  )

  it('prints the report as indented JSON', async () => {
    const { out, context, io } = setup(false)
    m.runSetup.mockResolvedValue({ exitCode: 0 })
    m.load.mockResolvedValue({ id: 'host' })
    await handleSetup(command({ json: true }), io, context)
    expect(out.stdout).toBe('{\n  "exitCode": 0\n}\n')
  })
})

describe('setup on a terminal', () => {
  it.each([
    [{}, { stdout: 'checking pi\n', stderr: '' }],
    [{ json: true }, { stdout: '{\n  "exitCode": 0\n}\n', stderr: 'checking pi\n' }],
  ])('guides setup %j, steps on stderr only for JSON', async (options, expected) => {
    const { out, targets, detached, context, io } = setup(true)
    m.runGuidedSetup.mockImplementation(async (guided: { print(line: string): void }) => {
      guided.print('checking pi')
      return { exitCode: 0 }
    })
    expect(await handleSetup(command(options), io, context)).toBe(0)
    expect(out).toEqual(expected)
    expect(m.runGuidedSetup.mock.calls[0]![0]).toMatchObject({
      fetch: context.control?.fetch,
      configPath: '/c.json',
      repositories: ['a'],
      signal: expect.any(AbortSignal),
    })
    expect(m.runSetup).not.toHaveBeenCalled()
    expect(targets).toHaveLength(1)
    expect(targets[0]!.log.hide('x')).toBe('Setup could not finish.')
    expect(detached()).toBe(1)
  })

  it('detaches when guided setup throws', async () => {
    const { detached, context, io } = setup(true)
    m.runGuidedSetup.mockRejectedValue(new Error('broken'))
    await expect(handleSetup(command(), io, context)).rejects.toThrow('broken')
    expect(detached()).toBe(1)
  })
})
