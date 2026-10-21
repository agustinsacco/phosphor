import { EMPTY_RESOURCES } from '@phosphor/session-runtime/pi/package-resources'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { controlMachine, type ControlMachine } from '../control/__fixtures__/machine'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import * as executables from '../machine/executables'
import { SetupCancelled } from './setup-terminal'
import { runGuidedSetup, type GuidedSetupContext } from './guided-setup'

let control: ControlMachine
let machine: FakeMachine
let context: GuidedSetupContext
let serviceRunning: boolean
let route: boolean
let operator: boolean
const operations: string[] = []
beforeEach(async () => {
  control = await controlMachine()
  machine = fakeMachine()
  serviceRunning = false
  route = false
  operator = true
  operations.length = 0
  await writeFile(
    control.configPath,
    JSON.stringify({ ...machine.config, repositories: [], control: control.config.control }),
    { mode: 0o600 },
  )
  context = {
    ...control.context,
    home: control.root,
    cwd: control.root,
    env: { HOME: control.root, PATH: machine.bin, USER: 'tester' },
    nodeVersion: process.versions.node,
    defaultResourceRoot: control.root,
    pi: machine.pi,
    node: process.execPath,
    packages: async () => [],
    setupTerminal: { confirm: async () => false, run: async () => 0 },
    service: {
      user: 'tester',
      node: process.execPath,
      bundle: join(control.root, 'phosphor.mjs'),
      runner: async (_program, args) => {
        operations.push(args.join(' '))
        if (args.includes('restart')) serviceRunning = true
        return {
          code: args.includes('is-active') && !serviceRunning ? 3 : 0,
          stdout: '',
          stderr: '',
        }
      },
    },
    tailscale: {
      which: async () => '/usr/bin/tailscale',
      probe: vi.fn(async (_file, args) => {
        if (args.includes('--bg')) {
          operations.push('tailscale enable')
          if (operator) route = true
          return {
            code: operator ? 0 : 1,
            signal: null,
            stdout: '',
            stderr: '',
            timedOut: false,
            truncated: false,
          }
        }
        return {
          code: 0,
          signal: null,
          timedOut: false,
          truncated: false,
          stdout: JSON.stringify(
            args[0] === 'debug'
              ? { OperatorUser: operator ? 'tester' : '' }
              : args[0] === 'status'
                ? {
                    BackendState: 'Running',
                    CertDomains: ['bee.tail.ts.net'],
                    Self: { DNSName: 'bee.tail.ts.net.' },
                  }
                : route
                  ? {
                      TCP: { '47615': { HTTPS: true } },
                      Web: {
                        'bee.tail.ts.net:47615': {
                          Handlers: { '/': { Proxy: 'http://127.0.0.1:47615' } },
                        },
                      },
                    }
                  : {},
          ),
          stderr: '',
        }
      }),
    },
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  machine.cleanup()
  await control.cleanup()
})

it('completes config, real enrollment, service and Serve once, then skips completed work', async () => {
  const before = await readFile(control.configPath, 'utf8')
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(serviceRunning && route).toBe(true)
  expect(JSON.parse(await readFile(control.configPath, 'utf8')).control).toEqual(
    JSON.parse(before).control,
  )
  expect(control.output.join('\n')).toContain('✓ Service          running')
  expect(control.output.join('\n')).not.toMatch(/Config ready|extra PATH|already set up|next:/)
  expect(operations.filter((op) => op.includes('restart'))).toHaveLength(1)
  const enrollments = control.calls.filter((call) => call.path.endsWith('/enrollments')).length
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(operations.filter((op) => op.includes('restart'))).toHaveLength(1)
  expect(operations.filter((op) => op === 'tailscale enable')).toHaveLength(1)
  expect(control.calls.filter((call) => call.path.endsWith('/enrollments'))).toHaveLength(
    enrollments,
  )
})
it('writes an empty config on first run and preserves it across cancelled login, then resumes', async () => {
  await rm(control.configPath)
  control.onWait(() => control.abort.abort())
  const cancelled = await runGuidedSetup(context)
  expect(cancelled.exitCode).toBe(130)
  const config = await readFile(control.configPath, 'utf8')
  expect(JSON.parse(config).repositories).toEqual([])
  expect(serviceRunning).toBe(false)
  control.onWait(undefined)
  const completed = await runGuidedSetup({ ...context, signal: new AbortController().signal })
  expect(completed.exitCode).toBe(0)
  expect(await readFile(control.configPath, 'utf8')).toBe(config)
  expect(control.calls.filter((call) => call.path.endsWith('/enrollments'))).toHaveLength(1)
})
it('keeps completed steps when operator permission is missing and resumes with exit 75', async () => {
  operator = false
  const report = await runGuidedSetup(context)
  expect(report.exitCode).toBe(75)
  expect(report.notes).toContain('Run: sudo tailscale set --operator=tester')
  expect(serviceRunning).toBe(false)
  operator = true
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(operations.filter((op) => op.includes('restart'))).toHaveLength(1)
})
it('stops at a service failure without changing the route', async () => {
  if (!context.service) throw new Error('fixture')
  context.service.runner = async () => ({ code: 1, stdout: '', stderr: '' })
  expect((await runGuidedSetup(context)).exitCode).toBe(75)
  expect(route).toBe(false)
})

it('does not restart running lanes when config changed, and does not repeat the warning unchanged', async () => {
  serviceRunning = true
  const replaced = await runGuidedSetup({
    ...context,
    replace: true,
    repositories: [machine.repository],
  })
  expect(replaced.exitCode).toBe(0)
  expect(replaced.changed).toBe(true)
  expect(replaced.notes).toContain(
    'Config changed. Run phosphor service restart to apply; running lanes stop.',
  )
  expect(operations.some((op) => op.includes('restart'))).toBe(false)
  expect(route).toBe(false)
  const unchanged = await runGuidedSetup(context)
  expect(unchanged.exitCode).toBe(0)
  expect(unchanged.notes.join('\n')).not.toContain('Config changed.')
  expect(operations.some((op) => op.includes('restart'))).toBe(false)
})
it('reinstalls a loaded but exited macOS job instead of treating it as running', async () => {
  context.platform = 'darwin'
  if (!context.service) throw new Error('fixture')
  context.service.runner = async (_program, args) => {
    operations.push(args.join(' '))
    return { code: 0, stdout: 'state = exited\nlast exit code = 77\n', stderr: '' }
  }
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(operations.some((op) => op.includes('bootstrap'))).toBe(true)
})

it('prompts before real sudo argv, rechecks operator permission, and skips it on rerun', async () => {
  operator = false
  const confirm = vi.fn(async (question: string) => question.startsWith('Run'))
  const run = vi.fn(async (file: string, args: readonly string[]) => {
    expect(file).toBe('/usr/bin/sudo')
    expect(args).toEqual(['/usr/bin/tailscale', 'set', '--operator=tester'])
    operator = true
    return 0
  })
  context.setupTerminal = { confirm, run }
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(run).toHaveBeenCalledTimes(1)
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(run).toHaveBeenCalledTimes(1)
})

it('does not continue when sudo succeeds without granting operator permission', async () => {
  operator = false
  context.setupTerminal = { confirm: async () => true, run: async () => 0 }
  expect((await runGuidedSetup(context)).exitCode).toBe(75)
  expect(serviceRunning).toBe(false)
})

it.each(['missing', 'signed-out'] as const)(
  'stops with one Tailscale fix when %s',
  async (state) => {
    if (!context.tailscale) throw new Error('fixture')
    if (state === 'missing') context.tailscale.which = async () => null
    else
      context.tailscale.probe = async () => ({
        code: 0,
        signal: null,
        stdout: '{"BackendState":"NeedsLogin"}',
        stderr: '',
        timedOut: false,
        truncated: false,
      })
    const report = await runGuidedSetup(context)
    expect(report.exitCode).toBe(69)
    expect(report.notes).toEqual([
      state === 'missing'
        ? 'Install Tailscale: https://tailscale.com/download'
        : 'Sign in to Tailscale: sudo tailscale up',
    ])
    expect(serviceRunning).toBe(false)
  },
)

it('sets up Claude with three separately approved commands, then skips all of them', async () => {
  let provider = false
  let signedIn = false
  context.packages = async () =>
    provider
      ? [
          {
            spec: 'npm:@saccolabs/pi-claude-cli',
            name: '@saccolabs/pi-claude-cli',
            version: '0.10.0',
            installed: true,
            scope: 'global',
            kind: 'npm',
            filtered: false,
            resources: EMPTY_RESOURCES,
          },
        ]
      : []
  const confirm = vi.fn(async () => true)
  const run = vi.fn(async (file: string, args: readonly string[]) => {
    if (file === '/bin/bash') {
      await mkdir(join(context.home, '.local/bin'), { recursive: true })
      await writeFile(
        join(context.home, '.local/bin/claude'),
        '#!/bin/sh\necho \'{"loggedIn":false}\'\nexit 1\n',
        { mode: 0o700 },
      )
    }
    if (args.includes('install')) provider = true
    if (file.endsWith('/claude')) {
      signedIn = true
      await writeFile(
        join(context.home, '.local/bin/claude'),
        '#!/bin/sh\necho \'{"loggedIn":true}\'\n',
        { mode: 0o700 },
      )
    }
    return 0
  })
  context.setupTerminal = { confirm, run }
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(signedIn).toBe(true)
  expect(run.mock.calls.map(([file, args]) => [file, ...args])).toEqual([
    ['curl', '-fsSL', 'https://claude.ai/install.sh', '-o', expect.stringMatching(/\/install.sh$/)],
    ['/bin/bash', expect.stringMatching(/\/install.sh$/)],
    [process.execPath, machine.pi, 'install', 'npm:@saccolabs/pi-claude-cli'],
    [join(context.home, '.local/bin/claude')],
  ])
  const count = confirm.mock.calls.length
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(confirm).toHaveBeenCalledTimes(count)
})

it('prints a single aligned checklist without internal setup noise', async () => {
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  const output = control.output.join('\n')
  expect(output).toContain('Phosphor setup for')
  for (const name of [
    'Tailscale',
    'Tailscale access',
    'pi',
    'Account',
    'Service',
    'Address',
    'Claude',
    'Folders',
  ])
    expect(output).toMatch(new RegExp(`  [✓?!-] ${name.padEnd(16)} `))
  expect(output).not.toMatch(
    /config {2}|node {2}|extra PATH|already set up|Port \d+: Run phosphor setup|next:/,
  )
  expect(output.split('\n').at(-1)).toMatch(/^Ready\. Open .+ in Phosphor\.$/)
})

it.each([true, false])('offers npm pi installation and honors approval %s', async (approved) => {
  await rm(control.configPath)
  await rm(machine.pi)
  context.pi = undefined
  const npm = machine.script('npm', 'exit 0')
  const confirm = vi.fn(async (question: string) => question.startsWith('Install pi') && approved)
  const run = vi.fn(async () => {
    await symlink(machine.cli, machine.pi)
    return 0
  })
  context.setupTerminal = { confirm, run }
  const report = await runGuidedSetup(context)
  expect(report.exitCode).toBe(approved ? 0 : 69)
  expect(control.output.join('\n')).toMatch(/ {2}! pi {15}not installed/)
  expect(run).toHaveBeenCalledTimes(approved ? 1 : 0)
  if (approved)
    expect(run).toHaveBeenCalledWith(
      npm,
      ['install', '-g', '@earendil-works/pi-coding-agent'],
      'task',
    )
  else expect(report.notes).toEqual(['Run: npm install -g @earendil-works/pi-coding-agent'])
})

it('prints Node and pi commands without invoking an installer when npm is missing', async () => {
  await rm(control.configPath)
  await rm(machine.pi)
  context.pi = undefined
  const originalWhich = executables.which
  vi.spyOn(executables, 'which').mockImplementation((name, path) =>
    name === 'npm' ? Promise.resolve(null) : originalWhich(name, path),
  )
  const confirm = vi.fn(async () => true)
  const run = vi.fn(async () => 0)
  context.setupTerminal = { confirm, run }
  const report = await runGuidedSetup(context)
  expect(report.exitCode).toBe(69)
  expect(report.notes).toEqual([
    'Install Node.js 22.19+: https://nodejs.org\nThen: npm install -g @earendil-works/pi-coding-agent',
  ])
  expect(confirm).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

it('keeps service, address and account when interrupted at the Claude prompt', async () => {
  context.setupTerminal = {
    confirm: async () => {
      throw new SetupCancelled()
    },
    run: async () => 0,
  }
  const report = await runGuidedSetup(context)
  expect(report.exitCode).toBe(130)
  expect(serviceRunning && route).toBe(true)
  expect(JSON.parse(await readFile(control.configPath, 'utf8')).pi.executable).toBe(machine.pi)
  context.setupTerminal = { confirm: async () => false, run: async () => 0 }
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(operations.filter((op) => op.includes('restart'))).toHaveLength(1)
})

it('does not run either Claude installer when its individual prompt is declined', async () => {
  const run = vi.fn(async () => 0)
  context.setupTerminal = { confirm: async (question) => question.startsWith('Set up Claude'), run }
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(run).not.toHaveBeenCalled()
  expect(control.output.join('\n')).toContain('Run: pi install npm:@saccolabs/pi-claude-cli')
})

it('offers the provider installer for an outdated package even with a ready CLI and login', async () => {
  machine.script('claude', 'echo \'{"loggedIn":true}\'')
  let updated = false
  context.packages = async () => [
    {
      spec: 'npm:@saccolabs/pi-claude-cli',
      name: '@saccolabs/pi-claude-cli',
      version: updated ? '0.10.0' : '0.9.9',
      installed: true,
      scope: 'global',
      kind: 'npm',
      filtered: false,
      resources: EMPTY_RESOURCES,
    },
  ]
  const run = vi.fn(async () => {
    updated = true
    return 0
  })
  context.setupTerminal = { confirm: async () => true, run }
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(run).toHaveBeenCalledTimes(1)
  expect(run).toHaveBeenCalledWith(
    process.execPath,
    [machine.pi, 'install', 'npm:@saccolabs/pi-claude-cli'],
    'task',
  )
})
