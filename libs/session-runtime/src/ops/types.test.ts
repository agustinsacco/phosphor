import { expectTypeOf, it } from 'vitest'
import type { ReadyOpFlag } from '@phosphor/shared/host-protocol'
import type { BrainOpsPort, LaneCommandOrigin, OpPrincipal, OpsBinding } from './types'

it('freezes the four op principals exactly as reconcile B2 names them', () => {
  expectTypeOf<Extract<OpPrincipal, { kind: 'surface' }>>().toEqualTypeOf<{
    readonly kind: 'surface'
    readonly clientId: string
    readonly label: string
    readonly via: 'grant' | 'owner'
  }>()
  expectTypeOf<Extract<OpPrincipal, { kind: 'agent' }>>().toEqualTypeOf<{
    readonly kind: 'agent'
    readonly laneRef: string
    readonly sessionId: string
    readonly unattended: boolean
    readonly lineage: number
  }>()
  expectTypeOf<Extract<OpPrincipal, { kind: 'machine' }>>().toEqualTypeOf<{
    readonly kind: 'machine'
    readonly machineId: string
    readonly clientId: string
    readonly label: string
    readonly lane: string | null
  }>()
  expectTypeOf<Extract<OpPrincipal, { kind: 'local' }>>().toEqualTypeOf<{
    readonly kind: 'local'
    readonly clientId: string
    readonly lane?: string
  }>()
  expectTypeOf<OpPrincipal['kind']>().toEqualTypeOf<'surface' | 'agent' | 'machine' | 'local'>()
})

it('names the lane command origins and the Brain port the owners bind', () => {
  expectTypeOf<LaneCommandOrigin>().toEqualTypeOf<'surface' | 'machine' | 'local'>()
  expectTypeOf<keyof BrainOpsPort>().toEqualTypeOf<'search' | 'flag'>()
  expectTypeOf<OpsBinding['flags']>().toEqualTypeOf<ReadonlySet<ReadyOpFlag>>()
  expectTypeOf<OpsBinding['brain']>().toEqualTypeOf<BrainOpsPort | undefined>()
})
