import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from './__fixtures__/machine'
import { runCli, type CliContext } from './cli'
import { fakeTerminal } from './ui/__fixtures__/fake-terminal'

let machine: FakeMachine | undefined
afterEach(() => {
  machine?.cleanup()
  machine = undefined
})

/** runCli on a person's terminal: what the screen shows, and what reached stdout and stderr. */
async function onTerminal(argv: string[], context: Partial<CliContext> = {}, keys?: string) {
  machine ??= fakeMachine()
  const screen = fakeTerminal()
  if (keys) screen.type(keys)
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    {
      env: machine.hostEnv,
      platform: 'linux',
      uid: process.getuid!(),
      home: machine.home,
      hostname: 'bee1',
      nodeVersion: '22.22.3',
      defaultResourceRoot: '/nonexistent',
      tailscale: { which: async () => null, probe: vi.fn() },
      terminal: true,
      rich: screen.terminal,
      ...context,
    },
  )
  return { code, screen: screen.text(), ...out }
}

it('draws doctor on the screen, with its spinner gone and nothing on stdout', async () => {
  machine = fakeMachine()
  const missing = join(machine.dir, 'missing.json')
  const result = await onTerminal(['doctor', '--config', missing])
  expect(result.stdout).toBe('')
  expect(result.screen).toMatch(/^┌ {2}phosphor doctor · bee1\n/)
  expect(result.screen).not.toContain('Checking this machine')
  expect(result.screen).toContain('Run phosphor setup')
  expect(result.screen).toMatch(/└ {2}Not ready \(exit \d+\)\./)
})

it('keeps --json plain on a terminal, for scripts that run there', async () => {
  machine = fakeMachine()
  const missing = join(machine.dir, 'missing.json')
  const result = await onTerminal(['doctor', '--json', '--config', missing])
  expect(result.screen).toBe('')
  expect(JSON.parse(result.stdout).next).toBe('run phosphor setup')
})

it('streams service logs as they are, without a screen', async () => {
  const runner = vi.fn(async () => ({ code: 0, stdout: 'journal line', stderr: '' }))
  const result = await onTerminal(['service', 'logs'], { service: { runner } })
  expect(result.screen).toBe('')
  expect(result.stdout).toBe('journal line\n')
})

it('shows a machine that is not signed in, and points it at setup', async () => {
  machine = fakeMachine()
  const result = await onTerminal(['status', '--config', machine.configPath])
  expect(result.code).toBe(69)
  expect(result.screen).toContain('▲  This machine is not signed in.')
  expect(result.screen).toContain('Next: phosphor setup')
})

it.each([
  ['n', 0, 'Nothing was uninstalled.'],
  ['\x1b', 130, 'Cancelled. Nothing was uninstalled.'],
])('asks before uninstalling, and %j leaves everything in place', async (key, code, closing) => {
  const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
  const result = await onTerminal(['uninstall'], { service: { runner } }, key)
  expect(result.code).toBe(code)
  expect(result.screen).toContain('Uninstall the Host program and its service?')
  expect(result.screen).toContain(`└  ${closing}`)
  expect(runner).not.toHaveBeenCalled()
})

it('still refuses --purge without --yes: a question is no substitute for asking twice', async () => {
  const runner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }))
  const result = await onTerminal(['uninstall', '--purge'], { service: { runner } })
  expect(result.code).toBe(64)
  expect(result.screen).toBe('')
  expect(runner).not.toHaveBeenCalled()
})
