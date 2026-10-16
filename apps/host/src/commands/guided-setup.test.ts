import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { controlMachine, type ControlMachine } from '../control/__fixtures__/machine'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
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
            args[0] === 'status'
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
  machine.cleanup()
  await control.cleanup()
})

it('completes config, real enrollment, service and Serve once, then skips completed work', async () => {
  const before = await readFile(control.configPath, 'utf8')
  expect((await runGuidedSetup(context)).exitCode).toBe(0)
  expect(serviceRunning && route).toBe(true)
  expect(await readFile(control.configPath, 'utf8')).toBe(before)
  expect(control.output).toContain('Config ready.')
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
  expect(report.notes).toContain('Config, login and service ready. Next: phosphor setup')
  expect(control.output.join('\n').split('\n')).toContain('sudo tailscale set --operator=$USER')
  expect(serviceRunning).toBe(true)
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
