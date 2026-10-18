import type { FrameSocket, HostFrame } from '../../host-protocol'
import type { GrantPayload } from '../../host-grant'
import type { ExtensionUIRequest } from '../../rpc'

export interface ConformanceConnection {
  socket: FrameSocket
  pause(): void
  resume(): void
  sever(): void
}
export interface HostConformanceHarness {
  claims: GrantPayload
  repositoryId?: string
  /** Exact scenario titles mapped to visible reasons; omitted when all scenarios are supported. */
  skippedScenarios?: Readonly<Record<string, string>>
  publicKey: Uint8Array
  connect(): ConformanceConnection
  mintGrant(claims?: Partial<GrantPayload>, badSignature?: boolean): string
  verifyProof(ready: Extract<HostFrame, { type: 'ready' }>, challenge: string): boolean
  signHelloProof(hostId: string, runtimeEpoch: string, challenge: string): string
  requestId(): string
  driver: {
    emitTurn(laneId: string): { messages: number; turns: number }
    openDialog(laneId: string, dialogId?: string): void
    failLane(laneId: string): void
    emitUi(laneId: string, request: ExtensionUIRequest): void
    restart(): void | Promise<void>
    revokeSession(id: string): void
    revokeClient(id: string): void
    executions(): number
    stop(): void | Promise<void>
  }
}
export interface ConformanceOptions {
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
}
export type HostConformanceFactory = (
  limits: Partial<ConformanceOptions>,
) => HostConformanceHarness | Promise<HostConformanceHarness>
