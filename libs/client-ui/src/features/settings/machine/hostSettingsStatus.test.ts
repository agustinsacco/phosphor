import { describe, expect, it } from 'vitest'
import type { MachineView } from '@shared/control-api'
import type { HostConnectionView } from '@shared/ipc'
import { hostSettingsStatus, type HostSettingsStatusInput } from './hostSettingsStatus'

const NOW = Date.parse('2026-11-02T12:00:00Z')
const MACHINE = {
  id: 'h1',
  label: 'bee2',
  state: 'running',
  lastSeenAt: new Date(NOW - 10_000).toISOString(),
  endpoint: 'bee2.tailnet.ts.net:7777',
  platform: 'linux',
} as MachineView

function status(
  state: HostConnectionView['state'] | undefined,
  overrides: Partial<HostSettingsStatusInput> = {},
  connection: Partial<HostConnectionView> = {},
) {
  return hostSettingsStatus({
    label: 'bee2',
    machine: MACHINE,
    connection: state ? { state, configurationSupported: true, ...connection } : undefined,
    allowed: state === 'ready',
    reads: 'settings',
    read: { loading: false, error: null, loaded: false },
    now: NOW,
    ...overrides,
  })
}

describe('hostSettingsStatus', () => {
  it.each([
    ['down', 'Not reachable', 'warning', 'reconnect'],
    ['no-address', 'Not reachable', 'warning', 'reconnect'],
    ['connecting', 'Connecting…', 'info', undefined],
    ['reconnecting', 'Connecting…', 'info', undefined],
    ['wrong-machine', 'Identity mismatch', 'danger', undefined],
    ['unsupported', 'Update needed', 'warning', undefined],
    ['signed-out', 'Signed out', 'warning', 'account'],
    [undefined, 'Not reachable', 'warning', 'reconnect'],
  ] as const)('gives %s its own notice and action', (state, title, tone, action) => {
    expect(status(state)).toMatchObject({ kind: 'notice', title, tone, action })
  })

  it('uses the Machines page reachability, fix command included', () => {
    const offline = { ...MACHINE, lastSeenAt: new Date(NOW - 3_600_000).toISOString() }
    expect(status('down', { machine: offline })).toMatchObject({
      title: 'Host offline',
      command: 'phosphor service restart',
      action: 'reconnect',
    })
    expect(status('unsupported')).toMatchObject({ command: 'phosphor update' })
  })

  it('shows the last error unless the reachability text already explains it', () => {
    expect(status('down', {}, { lastError: 'ECONNREFUSED' })).toMatchObject({
      lastError: 'ECONNREFUSED',
    })
    expect(status('connecting', {}, { lastError: 'forbidden' })).toMatchObject({
      title: 'Access refused',
      lastError: undefined,
      action: 'reconnect',
    })
  })

  it('names the link state for a Host the control plane has not listed', () => {
    expect(status('wrong-machine', { machine: undefined })).toMatchObject({
      title: 'Identity mismatch',
      action: undefined,
    })
    expect(status('down', { machine: undefined })).toMatchObject({
      title: 'Not connected',
      action: 'reconnect',
    })
  })

  it('then asks for an update, then for the configuration grant', () => {
    const update = status('ready', {}, { configurationSupported: false })
    expect(update).toMatchObject({
      title: 'Update this Host to use machine settings',
      command: 'phosphor update',
    })
    expect(update).not.toHaveProperty('action')
    expect(status('ready', { allowed: false })).toMatchObject({
      title: 'Configuration access is not enabled',
      action: 'enable-access',
    })
  })

  it('readies a section that reads only the link once the link is up, grant or not', () => {
    const link = { reads: 'connection', allowed: false } as const
    expect(status('ready', link, { configurationSupported: false })).toEqual({ kind: 'ready' })
    expect(status('down', link)).toMatchObject({ kind: 'notice', action: 'reconnect' })
  })

  it('is loading until the read lands, retries a failed read, and is ready once loaded', () => {
    expect(status('ready')).toEqual({ kind: 'loading' })
    expect(
      status('ready', { read: { loading: false, error: 'Host is busy', loaded: false } }),
    ).toMatchObject({ tone: 'danger', detail: 'Host is busy', action: 'retry' })
    expect(status('ready', { read: { loading: true, error: 'stale', loaded: true } })).toEqual({
      kind: 'ready',
    })
  })
})
