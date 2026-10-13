import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from '../__fixtures__/machine'
import type { ProbeResult } from '../machine/probe'
import { runTailscale } from './tailscale'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
  machine.writeConfig({ ...machine.config, api: { port: 50001 } })
})
afterEach(() => machine.cleanup())
const name = 'bee.tail123.ts.net'
const port = 50001
const status = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: `${name}.` },
  CertDomains: [name],
})
const ours = JSON.stringify({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${name}:${port}`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
})
const other = JSON.stringify({ TCP: { [port]: { TCPForward: 'localhost:22' } } })
const funnel = JSON.stringify({ AllowFunnel: { [`${name}:${port}`]: true } })
function fake(
  initial: string,
  after = initial,
  code = 0,
  statusText = status,
  extra: Partial<ProbeResult> = {},
) {
  let changed = false
  const probe = vi.fn(async (_file: string, args: readonly string[]): Promise<ProbeResult> => {
    const mutation = args[1] !== 'status' && args[0] !== 'status'
    const stdout =
      args[0] === 'status' ? statusText : mutation ? 'private output' : changed ? after : initial
    if (mutation) changed = true
    return {
      stdout,
      stderr: 'private output',
      code: mutation ? code : 0,
      signal: null,
      timedOut: false,
      truncated: false,
      ...(mutation ? extra : {}),
    }
  })
  return { probe, which: vi.fn(async (): Promise<string | null> => '/fake/tailscale') }
}
const context = () => ({
  configPath: machine.configPath,
  env: machine.hostEnv,
  platform: 'linux' as const,
  uid: process.getuid?.(),
})
const mutationArgs = (action: 'enable' | 'disable') =>
  action === 'enable'
    ? ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]
    : ['serve', `--https=${port}`, 'off']
const calls = (ports: ReturnType<typeof fake>) => ports.probe.mock.calls.map((call) => call[1])

describe('phosphor tailscale', () => {
  it.each(['enable', 'disable'] as const)(
    'runs exact %s argv and reads both statuses back',
    async (action) => {
      const ports = fake(action === 'enable' ? '{}' : ours, action === 'enable' ? ours : '{}')
      expect((await runTailscale(context(), action, ports)).exitCode).toBe(0)
      expect(calls(ports)).toEqual([
        ['status', '--json'],
        ['serve', 'status', '--json'],
        mutationArgs(action),
        ['status', '--json'],
        ['serve', 'status', '--json'],
      ])
    },
  )
  it.each(['enable', 'disable'] as const)('%s is idempotent', async (action) => {
    const ports = fake(action === 'enable' ? ours : '{}')
    expect((await runTailscale(context(), action, ports)).exitCode).toBe(0)
    expect(calls(ports)).toEqual([
      ['status', '--json'],
      ['serve', 'status', '--json'],
    ])
  })
  it.each(['enable', 'disable'] as const)(
    '%s refuses other routes and Funnel without running a mutation',
    async (action) => {
      for (const initial of [other, funnel]) {
        const ports = fake(initial)
        const found = await runTailscale(context(), action, ports)
        expect(found.exitCode).toBe(78)
        expect(found.message).toContain(
          `Port ${port}: the Host will not replace a route it did not make.`,
        )
        if (initial === funnel)
          expect(found.message).toContain(
            'Turn off Funnel because it would publish the Host to the internet.',
          )
        expect(calls(ports)).toEqual([
          ['status', '--json'],
          ['serve', 'status', '--json'],
        ])
      }
    },
  )
  it.each(['enable', 'disable'] as const)('%s requires verified readback', async (action) => {
    const ports = fake(action === 'enable' ? '{}' : ours)
    const found = await runTailscale(context(), action, ports)
    expect(found.exitCode).toBe(75)
    expect(found.message).toContain('could not be verified')
    expect(calls(ports)).toHaveLength(5)
  })
  it.each(['enable', 'disable'] as const)(
    '%s handles exit code and probe failures without output leaks or sudo',
    async (action) => {
      for (const extra of [
        { code: 1 },
        { timedOut: true },
        { truncated: true },
        { error: 'private' },
        { signal: 'SIGKILL' as const },
      ]) {
        const ports = fake(action === 'enable' ? '{}' : ours, '{}', extra.code ?? 0, status, extra)
        const found = await runTailscale(context(), action, ports)
        expect(found.exitCode).toBe(75)
        expect(found.message).toContain('sudo tailscale set --operator=$USER')
        expect(found.message).not.toContain('private')
        expect(calls(ports)).toHaveLength(3)
      }
      const found = await runTailscale(
        { ...context(), platform: 'darwin' },
        action,
        fake(action === 'enable' ? '{}' : ours, '{}', 1),
      )
      expect(found.message).not.toContain('sudo')
    },
  )
  it.each(['status', 'enable', 'disable'] as const)(
    '%s handles missing, stopped, no HTTPS, unknown route and invalid config',
    async (action) => {
      const missing = fake('{}')
      missing.which.mockResolvedValue(null)
      expect((await runTailscale(context(), action, missing)).exitCode).toBe(69)
      expect(missing.probe).not.toHaveBeenCalled()
      for (const text of [
        '{"BackendState":"Stopped"}',
        '{"BackendState":"Running","CertDomains":[]}',
      ]) {
        const ports = fake('{}', '{}', 0, text)
        expect((await runTailscale(context(), action, ports)).exitCode).toBe(69)
        expect(calls(ports).every((args) => args.includes('status'))).toBe(true)
      }
      const unknown = fake('bad')
      expect((await runTailscale(context(), action, unknown)).exitCode).toBe(69)
      expect(calls(unknown)).toHaveLength(2)
      machine.writeConfig({ version: 99 })
      const ports = fake('{}')
      expect((await runTailscale(context(), action, ports)).exitCode).toBe(78)
      expect(ports.probe).not.toHaveBeenCalled()
    },
  )
  it.each([
    [ours, 0, `https://${name}:${port}`],
    ['{}', 69, 'null'],
    [other, 69, 'null'],
    [funnel, 69, 'null'],
    ['bad', 69, 'null'],
  ] as const)('status reports state and endpoint for %s', async (initial, code, endpoint) => {
    const found = await runTailscale(context(), 'status', fake(initial))
    expect(found.exitCode).toBe(code)
    expect(found.message).toContain(`Endpoint: ${endpoint}`)
    expect(found.message).not.toContain('private')
  })
})
