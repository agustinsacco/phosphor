import { describe, expect, it, vi } from 'vitest'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { hostBrain, HostBrainError } from './brain'

const hostId = 'harbor'
const target = { hostId, connectionToken: 'kestrel-token' }
const request = { method: 'brain:find' as const, args: ['Mara Voss', 5] as [string, number] }
const found = { entities: [], memories: [], referenced: [], degradation: [] }

/** A ready Brain connection whose read call answers `reply` from ops.run. */
function page(reply: OpsRunResult) {
  const snapshot = {
    state: 'ready',
    brain: true,
    brainAccess: ['read'],
    capabilities: [],
    connectionToken: target.connectionToken,
  }
  const conn = {
    snapshot: () => snapshot,
    incarnation: () => ({ generation: 1 }),
    brainAuthorityEpoch: () => 1,
    call: vi.fn(async () => ({ type: 'result', id: 'c', ok: true, data: reply })),
    send: vi.fn(),
  }
  return hostBrain((id) => (id === hostId ? (conn as never) : undefined))
}

async function refusal(reply: OpsRunResult) {
  const error = await page(reply)
    .invoke(target, request)
    .catch((e: unknown) => e)
  expect(error).toBeInstanceOf(HostBrainError)
  const { code, message } = error as HostBrainError
  return { code, message }
}

describe('hostBrain invoke reads the Host reply', () => {
  it('returns the projected result of an ok reply', async () => {
    await expect(
      page({ status: 'ok', text: 'Found.', applies: 'now', data: found }).invoke(target, request),
    ).resolves.toEqual(found)
  })

  it('surfaces a denial with its code and text', async () => {
    expect(await refusal({ status: 'denied', code: 'busy', text: 'Ledger is busy.' })).toEqual({
      code: 'busy',
      message: 'Ledger is busy.',
    })
  })

  it('reads a confirmation as approval-required', async () => {
    const confirm = {
      status: 'confirm',
      confirmId: '33333333-3333-4333-8333-333333333333',
      digest: 'a'.repeat(64),
      title: 'Northwind',
      message: 'Approve',
      items: [{ hostId: null, op: 'archive.purge', ids: ['n1'], labels: ['Northwind'] }],
      expiresAt: 1,
    } as const
    expect(await refusal(confirm)).toEqual({
      code: 'approval-required',
      message: 'Brain access requires approval.',
    })
  })

  it('surfaces a Brain refusal carried in ok data', async () => {
    const reply = {
      status: 'ok',
      text: 'Brain is off for Rina Okafor.',
      applies: 'now',
      data: { brainRefusal: 'disabled' },
    } as const
    expect(await refusal(reply)).toEqual({
      code: 'disabled',
      message: 'Brain is off for Rina Okafor.',
    })
  })

  it('refuses an ok reply whose data is not a valid result', async () => {
    expect(
      await refusal({ status: 'ok', text: 'Found.', applies: 'now', data: { entities: 'x' } }),
    ).toEqual({
      code: 'invalid-result',
      message: 'The Host did not return a valid Brain result.',
    })
  })
})
