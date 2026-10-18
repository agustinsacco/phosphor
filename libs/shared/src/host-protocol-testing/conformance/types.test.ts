import { expectTypeOf, it } from 'vitest'
import type { FrameSocket, HostFrame } from '../../host-protocol'
import type { GrantPayload } from '../../host-grant'
import type { ExtensionUIRequest } from '../../rpc'
import type * as entry from '../conformance'
import type * as barrel from '../index'
import type {
  ConformanceConnection,
  ConformanceOptions,
  HostConformanceFactory,
  HostConformanceHarness,
} from './types'

// The harness contract both Hosts implement, as it stood before the split. These checks bite
// under typecheck; at runtime they only confirm the module loads.

it('re-exports the same harness types from the conformance entry and the testing barrel', () => {
  expectTypeOf<entry.ConformanceConnection>().toEqualTypeOf<ConformanceConnection>()
  expectTypeOf<entry.HostConformanceHarness>().toEqualTypeOf<HostConformanceHarness>()
  expectTypeOf<entry.ConformanceOptions>().toEqualTypeOf<ConformanceOptions>()
  expectTypeOf<entry.HostConformanceFactory>().toEqualTypeOf<HostConformanceFactory>()
  expectTypeOf<barrel.ConformanceConnection>().toEqualTypeOf<ConformanceConnection>()
  expectTypeOf<barrel.HostConformanceHarness>().toEqualTypeOf<HostConformanceHarness>()
  expectTypeOf<barrel.ConformanceOptions>().toEqualTypeOf<ConformanceOptions>()
  expectTypeOf<barrel.HostConformanceFactory>().toEqualTypeOf<HostConformanceFactory>()
})

it('keeps the connection, harness, driver, limits and factory shapes', () => {
  expectTypeOf<ConformanceConnection>().toEqualTypeOf<{
    socket: FrameSocket
    pause(): void
    resume(): void
    sever(): void
  }>()
  expectTypeOf<HostConformanceHarness['driver']>().toEqualTypeOf<{
    emitTurn(laneId: string): { messages: number; turns: number }
    openDialog(laneId: string, dialogId?: string): void
    failLane(laneId: string): void
    emitUi(laneId: string, request: ExtensionUIRequest): void
    restart(): void | Promise<void>
    revokeSession(id: string): void
    revokeClient(id: string): void
    executions(): number
    stop(): void | Promise<void>
  }>()
  expectTypeOf<HostConformanceHarness>().toEqualTypeOf<{
    claims: GrantPayload
    repositoryId?: string
    skippedScenarios?: Readonly<Record<string, string>>
    publicKey: Uint8Array
    connect(): ConformanceConnection
    mintGrant(claims?: Partial<GrantPayload>, badSignature?: boolean): string
    verifyProof(ready: Extract<HostFrame, { type: 'ready' }>, challenge: string): boolean
    signHelloProof(hostId: string, runtimeEpoch: string, challenge: string): string
    requestId(): string
    driver: HostConformanceHarness['driver']
  }>()
  expectTypeOf<ConformanceOptions>().toEqualTypeOf<{
    authTimeoutMs: number
    subscriptionsPerConnection: number
    pendingCommandsPerConnection: number
    replayEvents: number
    commandDelayMs: number
    inboundFrameBytes: number
    outboundFrameBytes: number
    sendQueueBytes: number
    receiptsKept: number
    receiptTtlMs: number
    connectionsPerClient: number
    replayBytes: number
    attentionReplay: number
    uiStatusKeys: number
    uiWidgetKeys: number
  }>()
  expectTypeOf<HostConformanceFactory>().toEqualTypeOf<
    (
      limits: Partial<ConformanceOptions>,
    ) => HostConformanceHarness | Promise<HostConformanceHarness>
  >()
})
