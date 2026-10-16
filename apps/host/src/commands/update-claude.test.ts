import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EMPTY_RESOURCES } from '@phosphor/session-runtime/pi/package-resources'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import { updateClaudeProvider } from './update'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
})
afterEach(() => {
  machine.cleanup()
  vi.restoreAllMocks()
})
it.each([0, 1])(
  'updates an installed provider with argv and warns without failing for exit %s',
  async (code) => {
    machine.writeConfig(machine.config)
    const run = vi.fn(async () => code)
    const print = vi.fn()
    await updateClaudeProvider({
      nodeVersion: process.versions.node,
      defaultResourceRoot: machine.dir,
      configPath: machine.configPath,
      uid: process.getuid?.(),
      home: machine.home,
      env: machine.hostEnv,
      platform: 'linux',
      hostname: 'test',
      print,
      packages: async () => [
        {
          name: '@saccolabs/pi-claude-cli',
          spec: 'npm:@saccolabs/pi-claude-cli',
          scope: 'global',
          kind: 'npm',
          filtered: false,
          installed: true,
          resources: EMPTY_RESOURCES,
        },
      ],
      setupTerminal: { confirm: async () => false, run },
    })
    expect(run).toHaveBeenCalledWith(process.execPath, [
      machine.pi,
      'update',
      'npm:@saccolabs/pi-claude-cli',
    ])
    expect(print.mock.calls.flat().join('')).toBe(
      code === 0
        ? ''
        : 'Warning: Claude provider update failed. Run: pi update npm:@saccolabs/pi-claude-cli',
    )
  },
)
it('does not install a provider during update', async () => {
  const run = vi.fn(async () => 0)
  await updateClaudeProvider({
    nodeVersion: process.versions.node,
    defaultResourceRoot: machine.dir,
    configPath: machine.configPath,
    uid: process.getuid?.(),
    home: machine.home,
    env: machine.hostEnv,
    platform: 'linux',
    hostname: 'test',
    print: () => {},
    packages: async () => [],
    setupTerminal: { confirm: async () => false, run },
  })
  expect(run).not.toHaveBeenCalled()
})
