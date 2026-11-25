import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseHostFrame, READY_OP_FLAGS } from '@phosphor/shared/host-protocol'
import type { HostHello } from '@phosphor/shared/remote-host'
import { readyFrame } from './ready-frame'

const hello: HostHello = {
  hostId: randomUUID(),
  hostVersion: '1.0.0',
  protocolVersion: 1,
  runtimeEpoch: '0123456789abcdef',
  capabilities: ['sessions.read', 'sessions.control'],
}
const base = {
  hello,
  grant: { caps: ['sessions.read'] as const, client: { id: randomUUID(), label: 'Laptop' } },
  key: generateKeyPairSync('ed25519').privateKey,
  challenge: 'a'.repeat(64),
  connectionId: '0123456789abcdef',
  grantExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  caps: ['sessions.read'] as const,
}

describe('ready frame op flags', () => {
  it('announces nothing new while the Host serves no op flag', () => {
    const plain = readyFrame({ ...base, grant: { ...base.grant, caps: [...base.grant.caps] } })
    const empty = readyFrame({ ...base, flags: new Set(), ownerLocal: false })
    expect(Object.keys(empty)).toEqual(Object.keys(plain))
    for (const flag of READY_OP_FLAGS) expect(empty).not.toHaveProperty(flag)
  })

  it('announces each served flag, and ownerLocal only on the owner connection', () => {
    const frame = readyFrame({ ...base, flags: new Set(['ops', 'laneEditing', 'ownerLocal']) })
    expect(frame).toMatchObject({ ops: true, laneEditing: true })
    expect(frame).not.toHaveProperty('ownerLocal')
    const owner = readyFrame({ ...base, flags: new Set(['ops']), ownerLocal: true })
    expect(owner).toMatchObject({ ops: true, ownerLocal: true })
    const parsed = parseHostFrame(JSON.stringify(owner))
    expect(parsed).toMatchObject({ ok: true, value: { ops: true, ownerLocal: true } })
  })
})

it('sends the local service policy only when configured', () => {
  expect(readyFrame(base)).not.toHaveProperty('warmOnOpen')
  expect(readyFrame({ ...base, warmOnOpen: true })).toMatchObject({ warmOnOpen: true })
})

it('advertises partial machine model reads', () => {
  expect(readyFrame(base)).toMatchObject({ partialModels: true })
})
