import { describe, expect, it } from 'vitest'
import type { ReachDirectory } from '@phosphor/session-runtime/ops/reach'
import { DIRECTORY_REFUSALS } from '../reach'
import { createHostResolver } from './remote'

const SELF = 'aaaaaaaa-0000-4000-8000-00000000000a'
const LOCAL = 'cccccccc-0000-4000-8000-00000000000c'
const BEE1 = 'b1b1b1b1-0000-4000-8000-000000000001'
const BEE2 = 'b2b2b2b2-0000-4000-8000-000000000002'
const TWIN = 'b1b1b1b1-9999-4000-8000-000000000003'

const machine = (id: string, label: string) => ({
  id,
  label,
  online: true,
  hostVersion: '0.3.0',
  ready: true,
})

function resolverOver(directory: ReachDirectory) {
  const reads = { count: 0 }
  const resolver = createHostResolver({
    directory: async () => {
      reads.count++
      return directory
    },
    selfIds: () => [SELF, LOCAL],
  })
  return { resolver, reads }
}

const listing: ReachDirectory = {
  available: true,
  self: { id: SELF, label: 'This Mac' },
  machines: [machine(BEE2, 'bee2'), machine(BEE1, 'Bee1'), machine(LOCAL, 'stale self row')],
}

describe('--host resolution on the Phosphor service', () => {
  it('names a machine by exact label in any case, or by an id prefix of 8 hex', async () => {
    const { resolver } = resolverOver(listing)
    expect(await resolver.resolve(['bee1'])).toEqual({
      ok: true,
      hosts: [{ id: BEE1, label: 'Bee1' }],
    })
    expect(await resolver.resolve(['b2b2b2b2', BEE1])).toEqual({
      ok: true,
      hosts: [
        { id: BEE2, label: 'bee2' },
        { id: BEE1, label: 'Bee1' },
      ],
    })
    expect(await resolver.resolve(['b2b2b2b'])).toEqual({
      ok: false,
      text: 'No machine on your account matches b2b2b2b. Run phosphor hosts.',
    })
  })

  it('lists the candidates when a value is ambiguous', async () => {
    const { resolver } = resolverOver({
      ...listing,
      machines: [machine(BEE1, 'bee'), machine(TWIN, 'bee'), machine(BEE2, 'bee2')],
    })
    expect(await resolver.resolve(['bee'])).toEqual({
      ok: false,
      text: 'Several machines match bee: bee (b1b1b1b1), bee (b1b1b1b1).',
    })
    expect(await resolver.resolve(['b1b1b1b1'])).toMatchObject({ ok: false })
    expect(await resolver.resolve(['b1b1b1b1-9'])).toEqual({
      ok: true,
      hosts: [{ id: TWIN, label: 'bee' }],
    })
  })

  it('counts a machine named twice once', async () => {
    const { resolver } = resolverOver(listing)
    expect(await resolver.resolve(['bee1', 'b1b1b1b1'])).toEqual({
      ok: true,
      hosts: [{ id: BEE1, label: 'Bee1' }],
    })
  })

  it('runs here when the one value names this machine by either id or its label', async () => {
    const { resolver, reads } = resolverOver(listing)
    expect(await resolver.resolve([SELF])).toEqual({ ok: true, self: true })
    expect(await resolver.resolve([LOCAL])).toEqual({ ok: true, self: true })
    expect(reads.count).toBe(0)
    expect(await resolver.resolve(['this mac'])).toEqual({ ok: true, self: true })
    expect(await resolver.resolve(['aaaaaaaa'])).toEqual({ ok: true, self: true })
  })

  it('refuses this machine named beside others', async () => {
    const { resolver } = resolverOver(listing)
    expect(await resolver.resolve(['bee1', 'This Mac'])).toEqual({
      ok: false,
      text: 'Leave this machine out of --host.',
    })
    expect(await resolver.resolve([LOCAL, 'bee2'])).toMatchObject({ ok: false })
  })

  it('resolves all to every other machine in directory order, never this one', async () => {
    const { resolver } = resolverOver({
      ...listing,
      machines: [...listing.machines, machine(SELF, 'This Mac')],
    })
    expect(await resolver.resolve('all')).toEqual({
      ok: true,
      hosts: [
        { id: BEE2, label: 'bee2' },
        { id: BEE1, label: 'Bee1' },
      ],
    })
  })

  it('says why no machine is reachable when the directory is unavailable', async () => {
    const { resolver } = resolverOver({ available: false, reason: 'control-old' })
    expect(await resolver.resolve('all')).toEqual({
      ok: false,
      text: DIRECTORY_REFUSALS['control-old'].message,
    })
    expect(await resolver.resolve(['bee1'])).toMatchObject({ ok: false })
  })
})
