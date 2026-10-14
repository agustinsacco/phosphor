import type { HostTerminals } from '../terminals/service'
import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { LaneCommandClient, LaneCommandFrame } from './commands'
import type { LaneStreams, LanesTopic } from './stream'

export interface LaneService {
  terminals?: HostTerminals
  epoch: string
  capabilities: readonly HostCapability[]
  commands: {
    capabilityFor?(op: LaneCommandFrame['op']): HostCapability
    submit(client: LaneCommandClient, frame: LaneCommandFrame): Promise<void>
    status(clientId: string, requestId: string, connectionId?: string): void
  }
  calls: {
    call(method: string, params: unknown): Promise<CallOutcome>
    capabilityFor(method: string): HostCapability | null
  }
  streams: LaneStreams
  lanesTopic: LanesTopic
  /** Publishes the current control of every active lane this client controls. */
  controllerPresence(clientId: string): void
}
export type CallOutcome =
  { ok: true; data: unknown } | { ok: false; error: { code: CallErrorCode; message: string } }
