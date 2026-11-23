import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { runDoctor, type DoctorContext } from './doctor'

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
