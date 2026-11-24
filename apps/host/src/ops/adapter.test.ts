import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { OpPrincipal } from '@phosphor/session-runtime/ops/types'
import type { ReadyConnection } from '../api/connection'
import { createOpsAdapter, type OpsAdapterPorts } from './adapter'
import { surfaceAdmits, type HostSurfacePrincipal } from './binding'

function connection(caps: readonly HostCapability[], label: string) {
  const sent: { type: string; data?: unknown }[] = []
  const socket = {
    isOpen: () => true,
    send: (text: string) => sent.push(JSON.parse(text) as { type: string }),
  } as unknown as FrameSocket
  const ready: ReadyConnection = {
    connectionId: randomUUID(),
    client: { id: randomUUID(), label },
    caps,
    socket,
    principal: { kind: 'grant-user', clientId: label },
  }
  return { ready, sent, caps }
}

const call = (id: string) =>
  ({ type: 'call', id, method: 'ops.run', params: { op: 'help', args: {} } }) as const

it('gives each surface request its own connection’s capabilities, even interleaved', async () => {
  const seen: OpPrincipal[] = []
  const releases: (() => void)[] = []
  const slot: OpsAdapterPorts = {}
  const adapter = createOpsAdapter(slot)
  const reader = connection(['sessions.read'], 'reader')
  const configurer = connection(['sessions.read', 'sessions.control', 'machine.configure'], 'admin')
  slot.dispatcher = {
    run: (principal: OpPrincipal, _request: OpsRunRequest) =>
      new Promise<OpsRunResult>((resolve) => {
        seen.push(principal)
        releases.push(() => resolve({ status: 'ok', text: 'ok', applies: 'now' }))
      }),
  }
  const a = adapter(reader.ready)!
  const b = adapter(configurer.ready)!
  a.handle(call('a1'), reader.caps)
  b.handle(call('b1'), configurer.caps)
  a.handle(call('a2'), reader.caps)
  await new Promise((r) => setTimeout(r, 0))
  for (const release of releases) release()
  await new Promise((r) => setTimeout(r, 0))
  const byLabel = (label: string) =>
    seen
      .filter((p) => p.kind === 'surface' && p.label === label)
      .map((p) => ('caps' in p ? p.caps : null))
  expect(byLabel('reader').length).toBeGreaterThanOrEqual(1)
  for (const caps of byLabel('reader')) expect(caps).toEqual(['sessions.read'])
  expect(byLabel('admin')).toEqual([['sessions.read', 'sessions.control', 'machine.configure']])
  const configure = { caps: ['sessions.control' as const], configure: true as const }
  const [readerPrincipal] = seen.filter((p) => p.kind === 'surface' && p.label === 'reader')
  const [adminPrincipal] = seen.filter((p) => p.kind === 'surface' && p.label === 'admin')
  expect(surfaceAdmits(readerPrincipal as never, configure)).toBe(false)
  expect(surfaceAdmits(adminPrincipal as never, configure)).toBe(true)
})

it('reads the slot per connection: one made before the dispatcher is bound answers unsupported', () => {
  const slot: OpsAdapterPorts = {}
  const adapter = createOpsAdapter(slot)
  const early = connection(['sessions.read'], 'early')
  const before = adapter(early.ready)!
  slot.dispatcher = { run: async () => ({ status: 'ok', text: 'ok', applies: 'now' }) }
  before.handle(call('e1'), early.caps)
  expect(early.sent).toEqual([
    { type: 'result', id: 'e1', ok: false, error: { code: 'unsupported', message: 'unsupported' } },
  ])
})

it('refuses a surface principal that carries no capabilities', () => {
  const bare = { kind: 'surface', clientId: 'c', label: 'x', via: 'grant' } as const
  const withNone: HostSurfacePrincipal = { ...bare, caps: [] }
  expect(surfaceAdmits(bare, {})).toBe(false)
  expect(surfaceAdmits(withNone, {})).toBe(true)
})

it.each(['grant-user', 'grant-machine', 'owner'] as const)('never admits ops.cli as %s', (kind) => {
  const { ready, caps, sent } = connection([], 'other')
  const principal = { kind, clientId: ready.client.id, machineId: randomUUID() }
  const adapter = createOpsAdapter({
    dispatcher: {
      run: async () => {
        throw Error('unexpected')
      },
    },
  })
  const handled = adapter({ ...ready, principal })!.handle(
    { type: 'call', id: 'a', method: 'ops.cli', params: {} },
    caps,
  )
  expect(handled).toBe(true)
  expect(sent).toMatchObject([{ ok: false, error: { code: 'forbidden' } }])
})
