import { describe, expect, it, vi } from 'vitest'
import type { HostsSnapshot } from '@shared/ipc'
import { healthSummary, runHealthCheck, type HealthRun } from './healthCheck'
import { MACHINE } from './__fixtures__/control'

const now = Date.parse('2026-10-01T00:00:00Z')
const ready = {
  ...MACHINE,
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  label: 'bee1',
  lastSeenAt: new Date(now).toISOString(),
  state: 'running' as const,
  endpoint: 'https://bee1.tail.ts.net:47615',
}
const unreachable = {
  ...ready,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  label: 'bee2',
  endpoint: null,
}
const hosts: HostsSnapshot = {
  [ready.id]: {
    connectionToken: 't',
    state: 'ready',
    hostVersion: '0.2.5',
    capabilities: ['sessions.read', 'skills.read'],
    repositories: [{ id: 'r', name: 'repo' } as never],
    lanes: [],
  },
  [unreachable.id]: {
    connectionToken: 'u',
    state: 'no-address',
    capabilities: [],
    repositories: [],
    lanes: [],
  },
}
function invoke() {
  return vi.fn(async (channel: string): Promise<unknown> => {
    switch (channel) {
      case 'hosts:tailscaleStatus':
        return { code: 'ready' }
      case 'pi:health':
        return { ok: true, version: '1.2.0' }
      case 'hosts:providers':
        return [
          { id: 'a', name: 'A', status: 'ready' },
          { id: 'b', name: 'B', status: 'not_ready' },
        ]
      case 'hosts:models':
        return []
      case 'hosts:claude':
        return { provider: 'missing', cli: 'ok', auth: 'ok' }
      case 'hosts:skills':
        throw new Error('Not available on remote lanes yet.')
      default:
        throw new Error(`unexpected ${channel}`)
    }
  })
}

describe('health check', () => {
  it('times every read, skips what is not connected or granted, and reports failures', async () => {
    const calls = invoke()
    const updates: HealthRun[] = []
    let tick = 0
    const run = await runHealthCheck({
      invoke: calls as never,
      localLabel: 'This Mac',
      signedIn: true,
      refreshDirectory: async () => null,
      machines: () => [ready, unreachable],
      hosts: () => hosts,
      now: () => now,
      clock: () => (tick += 5),
      onUpdate: (r) => updates.push(r),
    })
    const steps = (id: string) =>
      Object.fromEntries(
        run.targets.find((t) => t.id === id)?.steps.map((s) => [s.id, [s.tone, s.detail]]) ?? [],
      )
    expect(steps('local')).toEqual({
      control: ['ok', '2 machines'],
      tailscale: ['ok', 'Running with MagicDNS and HTTPS'],
      pi: ['ok', 'pi 1.2.0'],
    })
    expect(steps(ready.id)).toEqual({
      heartbeat: ['ok', 'Checked in just now'],
      connection: ['ok', 'Connected · Host 0.2.5'],
      providers: ['ok', '2 providers · 1 signed in'],
      models: ['warn', 'No usable models'],
      claude: ['warn', 'Claude Code provider missing'],
      skills: ['error', 'Not available on remote lanes yet.'],
      routines: ['off', 'Not granted to this computer'],
      lanes: ['ok', '0 lanes · 1 folder'],
    })
    expect(steps(unreachable.id).connection).toEqual(['warn', 'Not reachable'])
    expect(steps(unreachable.id).providers).toBeUndefined()
    expect(steps(unreachable.id).reads).toEqual([
      'off',
      'Skipped until connected: Providers, Models, Claude Code, Skills, Routines, Lanes',
    ])
    expect(calls).not.toHaveBeenCalledWith('hosts:providers', unreachable.id)
    expect(run.targets.flatMap((t) => t.steps).every((s) => s.tone !== 'running')).toBe(true)
    expect(run.targets[0]?.steps[0]?.ms).toBe(5)
    expect(
      updates.some((u) => u.targets.some((t) => t.steps.some((s) => s.tone === 'running'))),
    ).toBe(true)
    expect(run.finishedAt).toBeDefined()
  })

  it('reports a control failure and does not touch Hosts when signed out', async () => {
    const calls = invoke()
    const failed = await runHealthCheck({
      invoke: calls as never,
      localLabel: 'This Mac',
      signedIn: true,
      refreshDirectory: async () => 'offline',
      machines: () => [],
      hosts: () => ({}),
      now: () => now,
      onUpdate: () => {},
    })
    expect(failed.targets[0]?.steps[0]).toMatchObject({ tone: 'error' })
    const signedOut = await runHealthCheck({
      invoke: calls as never,
      localLabel: 'This Mac',
      signedIn: false,
      refreshDirectory: async () => null,
      machines: () => [ready],
      hosts: () => hosts,
      now: () => now,
      onUpdate: () => {},
    })
    expect(signedOut.targets.map((t) => t.id)).toEqual(['local'])
    expect(signedOut.targets[0]?.steps[0]).toMatchObject({ tone: 'off', detail: 'Signed out' })
  })

  it('summarizes live state and a recent run into one badge', () => {
    const base = {
      running: false,
      controlError: false,
      signedIn: true,
      machines: [ready],
      hosts,
      now,
      run: null,
      wallNow: now,
    }
    expect(healthSummary(base)).toMatchObject({ tone: 'ok', label: 'All systems normal' })
    expect(healthSummary({ ...base, running: true }).label).toBe('Checking…')
    expect(healthSummary({ ...base, controlError: true })).toMatchObject({ tone: 'error' })
    expect(healthSummary({ ...base, machines: [ready, unreachable] })).toMatchObject({
      tone: 'warn',
      label: '1 issue',
    })
    expect(healthSummary({ ...base, machines: [MACHINE] }).label).toBe('Waiting for setup')
    const old = { ...ready, lastSeenAt: new Date(now - 3600_000).toISOString() }
    const down = { [ready.id]: { ...hosts[ready.id]!, state: 'down' as const } }
    expect(healthSummary({ ...base, machines: [old], hosts: down })).toMatchObject({
      tone: 'off',
      label: '1 offline',
    })
    const run: HealthRun = {
      startedAt: now,
      finishedAt: now,
      targets: [
        { id: ready.id, label: 'bee1', steps: [{ id: 'm', label: 'M', tone: 'warn', detail: '' }] },
      ],
    }
    expect(healthSummary({ ...base, run }).label).toBe('1 issue')
    expect(healthSummary({ ...base, run, wallNow: now + 11 * 60_000 }).label).toBe(
      'All systems normal',
    )
  })
})
