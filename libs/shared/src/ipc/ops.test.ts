import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap, OpsChangedEvent } from '../ipc'
import type { OpsRunRequest, OpsRunResult } from '../host-protocol-ops'
import type { HostTarget } from '../remote-host'
import type { OpsInvokeMap } from './ops'

export interface BaselineOpsInvokeMap {
  'ops:run': { args: [target: HostTarget, request: OpsRunRequest]; result: OpsRunResult }
}
export interface BaselineOpsChangedEvent {
  machine: string
  kind: 'audit' | 'policy' | 'confirm' | 'lane'
  laneRef?: string
  fields?: string[]
}

it('freezes the one ops channel and its change event through ipc.ts', () => {
  expectTypeOf<Pick<IpcInvokeMap, 'ops:run'>>().toEqualTypeOf<BaselineOpsInvokeMap>()
  expectTypeOf<OpsChangedEvent>().toEqualTypeOf<BaselineOpsChangedEvent>()
})

it('keeps ops leaf exact and confined to its prefix', () => {
  expectTypeOf<OpsInvokeMap>().toEqualTypeOf<BaselineOpsInvokeMap>()
  expectTypeOf<keyof OpsInvokeMap>().toEqualTypeOf<Extract<keyof IpcInvokeMap, `ops:${string}`>>()
})
