import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
    // 'task': the provider update needs no input, so a terminal may show it as a log.
    expect(run).toHaveBeenCalledWith(
      process.execPath,
      [machine.pi, 'update', 'npm:@saccolabs/pi-claude-cli'],
      'task',
    )
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
it('stops a stalled provider update when the Host update is cancelled', async () => {
  const stalled = join(machine.dir, 'stalled-pi.cjs')
  writeFileSync(stalled, 'setTimeout(() => {}, 60_000)\n')
  machine.writeConfig({ ...machine.config, pi: { node: process.execPath, executable: stalled } })
  const lifetime = new AbortController()
  setTimeout(() => lifetime.abort(), 200)
  const started = Date.now()
  await expect(
    updateClaudeProvider(
      {
        nodeVersion: process.versions.node,
        defaultResourceRoot: machine.dir,
        configPath: machine.configPath,
        uid: process.getuid?.(),
        home: machine.home,
        env: machine.hostEnv,
        platform: 'linux',
        hostname: 'test',
        print: () => {},
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
      },
      lifetime.signal,
    ),
  ).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(10_000)
})
it('rethrows a cancellation that lands while packages are being listed', async () => {
  const lifetime = new AbortController()
  const print = vi.fn()
  await expect(
    updateClaudeProvider(
      {
        nodeVersion: process.versions.node,
        defaultResourceRoot: machine.dir,
        configPath: machine.configPath,
        uid: process.getuid?.(),
        home: machine.home,
        env: machine.hostEnv,
        platform: 'linux',
        hostname: 'test',
        print,
        packages: async () => {
          lifetime.abort()
          return []
        },
      },
      lifetime.signal,
    ),
  ).rejects.toThrow()
  expect(print).not.toHaveBeenCalled()
})
