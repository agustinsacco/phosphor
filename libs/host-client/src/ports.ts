import type { AttachmentOp } from '@phosphor/shared/host-protocol-attachments'
import type { FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import type { HostCapability } from '@phosphor/shared/remote-host'

export type TraceLog = (scope: string, message: string, data?: unknown) => void
export interface WriteLane {
  laneId?: string
  workspacePath: string
  call: (capability: HostCapability, method: string, params: unknown) => Promise<unknown>
  write(op: FileWriteOp | AttachmentOp): Promise<unknown>
}
