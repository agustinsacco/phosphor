import { describe, expect, expectTypeOf, it } from 'vitest'
import * as facade from '../host-protocol'
import type { AttachmentOp } from '../host-protocol-attachments'
import type { ProviderLoginOp } from '../host-protocol-providers'
import type { DeleteLaneOp, RepositoryOp } from '../host-protocol-repositories'
import type { ROUTINE_OPS, RoutineOp } from '../host-protocol-routines'
import type { TerminalOp } from '../host-protocol-terminals'
import type { FileWriteOp } from '../host-protocol-writes'
import type { RpcCommand } from '../rpc'
import {
  CAPABILITY_FOR,
  HOST_CALL_METHODS,
  LANE_PI_OPS,
  UNFENCED_OPS,
  type CallError,
  type CallErrorCode,
  type FailureCode,
  type HostCallMethod,
  type LaneOp,
  type LaneOpType,
  type LanePiOp,
  type LanePiOpType,
  type RejectCode,
} from './operations'

describe('host-protocol operation declarations', () => {
  it('keeps the pi op allowlist, unfenced ops and call methods in order', () => {
    expect(LANE_PI_OPS).toStrictEqual([
      'prompt',
      'steer',
      'follow_up',
      'abort',
      'abort_retry',
      'set_model',
      'set_thinking_level',
      'compact',
      'set_session_name',
    ])
    expect(UNFENCED_OPS).toStrictEqual([
      'lane.create',
      'lane.markRead',
      'control.take',
      'host.repositories.add',
      'host.repositories.remove',
      'host.repositories.createFolder',
    ])
    expect(HOST_CALL_METHODS).toStrictEqual([
      'host.repositories',
      'lane.state',
      'lane.messages',
      'lane.receipt',
      'lane.stats',
      'lane.models',
      'lane.commands',
    ])
    expectTypeOf<LanePiOpType>().toEqualTypeOf<(typeof LANE_PI_OPS)[number]>()
    expectTypeOf<HostCallMethod>().toEqualTypeOf<(typeof HOST_CALL_METHODS)[number]>()
  })

  it('admits the subscription, call and command capabilities exactly', () => {
    expect(CAPABILITY_FOR).toStrictEqual({
      subscribeLanes: 'sessions.read',
      subscribeLane: 'sessions.read',
      call: 'sessions.read',
      command: 'sessions.control',
    })
  })

  it('keeps the operation union: every family and every op type', () => {
    type Core = Exclude<
      LaneOp,
      | RepositoryOp
      | DeleteLaneOp
      | ProviderLoginOp
      | TerminalOp
      | RoutineOp
      | FileWriteOp
      | AttachmentOp
      | LanePiOp
    >
    expectTypeOf<Core['type']>().toEqualTypeOf<
      | 'extension_ui_response'
      | 'lane.create'
      | 'lane.resume'
      | 'lane.stop'
      | 'lane.markRead'
      | 'control.take'
      | 'control.release'
    >()
    expectTypeOf<LanePiOp>().toEqualTypeOf<
      Extract<RpcCommand, { type: LanePiOpType }> extends infer C
        ? C extends unknown
          ? Omit<C, 'id'>
          : never
        : never
    >()
    expectTypeOf<LaneOpType>().toEqualTypeOf<
      | LanePiOpType
      | Core['type']
      | RepositoryOp['type']
      | DeleteLaneOp['type']
      | ProviderLoginOp['type']
      | TerminalOp['type']
      | (typeof ROUTINE_OPS)[number]
      | FileWriteOp['type']
      | AttachmentOp['type']
    >()
    expectTypeOf<Extract<LaneOp, { type: 'lane.create' }>['worktree']>().toEqualTypeOf<{
      readonly branch: string
      readonly fresh?: true
    } | null>()
  })

  it('keeps every reject, failure and call error code', () => {
    expectTypeOf<RejectCode>().toEqualTypeOf<
      | 'bad-request'
      | 'unsupported'
      | 'forbidden'
      | 'unknown-lane'
      | 'lane-stopped'
      | 'not-controller'
      | 'stale-fence'
      | 'conflict'
      | 'busy'
      | 'branch-exists'
      | 'last-repository'
      | 'too-many-requests'
    >()
    expectTypeOf<FailureCode>().toEqualTypeOf<'pi-error' | 'timeout' | 'internal'>()
    expectTypeOf<CallErrorCode>().toEqualTypeOf<
      | 'bad-request'
      | 'unsupported'
      | 'forbidden'
      | 'unknown-lane'
      | 'lane-stopped'
      | 'too-large'
      | 'internal'
    >()
    expectTypeOf<CallError>().toEqualTypeOf<{
      readonly code: CallErrorCode
      readonly message: string
    }>()
  })

  it('is what the public entry exports', () => {
    expect(facade.LANE_PI_OPS).toBe(LANE_PI_OPS)
    expect(facade.UNFENCED_OPS).toBe(UNFENCED_OPS)
    expect(facade.HOST_CALL_METHODS).toBe(HOST_CALL_METHODS)
    expect(facade.CAPABILITY_FOR).toBe(CAPABILITY_FOR)
    expectTypeOf<facade.LaneOp>().toEqualTypeOf<LaneOp>()
    expectTypeOf<facade.LaneOpType>().toEqualTypeOf<LaneOpType>()
    expectTypeOf<facade.LanePiOp>().toEqualTypeOf<LanePiOp>()
    expectTypeOf<facade.LanePiOpType>().toEqualTypeOf<LanePiOpType>()
    expectTypeOf<facade.RejectCode>().toEqualTypeOf<RejectCode>()
    expectTypeOf<facade.FailureCode>().toEqualTypeOf<FailureCode>()
    expectTypeOf<facade.CallErrorCode>().toEqualTypeOf<CallErrorCode>()
    expectTypeOf<facade.CallError>().toEqualTypeOf<CallError>()
    expectTypeOf<facade.HostCallMethod>().toEqualTypeOf<HostCallMethod>()
  })
})
