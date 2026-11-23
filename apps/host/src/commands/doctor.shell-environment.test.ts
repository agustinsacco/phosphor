import { applySpawnContributions } from '@phosphor/session-runtime/pi/spawn-contributions'
import { opChildEnv } from '@phosphor/session-runtime/pi/op-channel'
import { hostSpawnContributions } from '../session/contributions'
import { createHostLog } from '../machine/log'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { inspectHost, runDoctor, type DoctorContext } from './doctor'

let machine: FakeMachine
let context: DoctorContext
beforeEach(() => {
  machine = fakeMachine()
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
  const shell = machine.script(
    'shell',
    `touch "$HOME/invoked"\nexport PASSED_TOKEN=test-passed-value\nexport PATH="$HOME/bin:$PATH"\neval "$2"`,
  )
  machine.writeConfig({ ...machine.config, environment: { pass: ['PASSED_TOKEN'] } })
  context = {
    configPath: machine.configPath,
    platform: 'darwin',
    uid: process.getuid!(),
    home: machine.home,
    hostname: 'test-host',
    nodeVersion: process.version,
    defaultResourceRoot: '',
    tailscale: { which: async () => null, probe: vi.fn() },
    env: {
      HOME: machine.home,
      PI_CODING_AGENT_DIR: machine.agentDir,
      PATH: '/usr/bin:/bin',
      SHELL: shell,
    },
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  machine.cleanup()
})

it('headless doctor builds a policy PATH without consulting a login shell', async () => {
  const report = await runDoctor(context)
  expect(existsSync(join(machine.home, 'invoked'))).toBe(false)
  expect(report.environment?.names).not.toContain('PASSED_TOKEN')
  expect(report.environment?.path).not.toContain(join(machine.home, 'bin'))
  expect(report.checks.map(({ id }) => id)).not.toContain('shell-env')
})

it('a local lane receives the login-shell PATH and passed token through its spawn contribution', async () => {
  writeFileSync(
    join(dirname(context.configPath), 'local-mode.json'),
    JSON.stringify({ version: 1, enabledAt: 'today', shellEnvironment: true }),
    { mode: 0o600 },
  )
  const { report, machine: inspected } = await inspectHost(context, { captureShell: true })
  expect(report.environment?.path[0]).toBe(join(machine.home, 'bin'))
  expect(report.environment?.names).toContain('PASSED_TOKEN')
  expect(JSON.stringify(report)).not.toContain('test-passed-value')
  expect(report.checks).toContainEqual(expect.objectContaining({ id: 'shell-env', status: 'pass' }))
  expect(inspected?.env).not.toHaveProperty('PASSED_TOKEN')
  expect(inspected?.shellEnvironment).toBeDefined()
  const log = createHostLog(join(machine.dir, 'logs'), [])
  const contributions = hostSpawnContributions(inspected!.shellEnvironment, log)
  const spawn = async () => {
    const options = { env: { ...inspected!.env } }
    await applySpawnContributions(
      contributions,
      options,
      {},
      { options: { workspacePath: machine.repository } },
      log.write,
    )
    return opChildEnv(options.env, false)
  }
  const original = await spawn()
  expect(original.PATH?.split(':')[0]).toBe(join(machine.home, 'bin'))
  expect(original.PASSED_TOKEN).toBe('test-passed-value')
  expect(log.hide('test-passed-value')).toBe('[redacted]')
  machine.script(
    'shell',
    `export PASSED_TOKEN=changed-test-value\nexport PATH="$HOME/updated:$PATH"\neval "$2"`,
  )
  expect(await spawn()).toEqual(original)
  await inspected!.shellEnvironment!.refresh()
  expect((await spawn()).PATH?.split(':')[0]).toBe(join(machine.home, 'updated'))
  expect(original.PASSED_TOKEN).toBe('test-passed-value')
  machine.script('shell', 'exit 1')
  await inspected!.shellEnvironment!.refresh()
  expect((await spawn()).PASSED_TOKEN).toBe('changed-test-value')
  expect(log.hide('changed-test-value test-passed-value')).toBe('[redacted] [redacted]')
})
