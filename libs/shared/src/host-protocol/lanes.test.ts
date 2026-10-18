import { describe, expectTypeOf, it } from 'vitest'
import type * as facade from '../host-protocol'
import type { LaneReceipt } from '../lane-receipt'
import type { SessionPush } from '../models'
import type { AgentMessage, ExtensionUIRequest, PiEvent, RpcSessionState } from '../rpc'
import type * as lanes from './lanes'
import type { Receipt } from './operations'

// lanes.ts holds declarations only, so these checks run when tsc checks this file.
describe('host-protocol lane declarations', () => {
  it('reach clients unchanged through the public entry, with both receipt types', () => {
    expectTypeOf<facade.StreamCursor>().toEqualTypeOf<lanes.StreamCursor>()
    expectTypeOf<facade.RepositorySummary>().toEqualTypeOf<lanes.RepositorySummary>()
    expectTypeOf<facade.LaneController>().toEqualTypeOf<lanes.LaneController>()
    expectTypeOf<facade.LaneControl>().toEqualTypeOf<lanes.LaneControl>()
    expectTypeOf<facade.LaneActivity>().toEqualTypeOf<lanes.LaneActivity>()
    expectTypeOf<facade.LaneSummary>().toEqualTypeOf<lanes.LaneSummary>()
    expectTypeOf<facade.LaneSnapshot>().toEqualTypeOf<lanes.LaneSnapshot>()
    expectTypeOf<facade.LanePiPush>().toEqualTypeOf<lanes.LanePiPush>()
    expectTypeOf<facade.LaneEvent>().toEqualTypeOf<lanes.LaneEvent>()
    expectTypeOf<facade.AttentionKind>().toEqualTypeOf<lanes.AttentionKind>()
    expectTypeOf<facade.AttentionEvent>().toEqualTypeOf<lanes.AttentionEvent>()
    expectTypeOf<facade.LaneReceipt>().toEqualTypeOf<LaneReceipt>()
    expectTypeOf<facade.Receipt>().toEqualTypeOf<Receipt>()
  })

  it('keep their member sets', () => {
    expectTypeOf<lanes.StreamCursor>().toEqualTypeOf<{
      readonly epoch: string
      readonly seq: number
    }>()
    expectTypeOf<lanes.LaneActivity>().toEqualTypeOf<
      'stopped' | 'idle' | 'working' | 'needs-input' | 'failed'
    >()
    expectTypeOf<lanes.AttentionKind>().toEqualTypeOf<
      'finished' | 'needs-input' | 'failed' | 'routine-finished' | 'routine-paused'
    >()
    expectTypeOf<lanes.LaneEvent['kind']>().toEqualTypeOf<
      'pi' | 'control' | 'summary' | 'dialog-resolved'
    >()
    expectTypeOf<lanes.LanePiPush>().toEqualTypeOf<
      Exclude<SessionPush, { kind: 'stderr' | 'resync' }>
    >()
    expectTypeOf<lanes.LaneControl['controller']>().toEqualTypeOf<lanes.LaneController | null>()
    expectTypeOf<Receipt['status']>().toEqualTypeOf<
      'pending' | 'done' | 'failed' | 'rejected' | 'unknown'
    >()
  })

  it('carry pi payloads as pi declares them', () => {
    expectTypeOf<lanes.LaneSnapshot['state']>().toEqualTypeOf<RpcSessionState | null>()
    expectTypeOf<lanes.LaneSnapshot['messages']>().toEqualTypeOf<readonly AgentMessage[]>()
    expectTypeOf<lanes.LaneSnapshot['pending']>().toEqualTypeOf<readonly PiEvent[]>()
    expectTypeOf<lanes.LaneSnapshot['dialogs']>().toEqualTypeOf<readonly ExtensionUIRequest[]>()
    expectTypeOf<lanes.LaneSnapshot['ui']>().toEqualTypeOf<readonly ExtensionUIRequest[]>()
  })
})
