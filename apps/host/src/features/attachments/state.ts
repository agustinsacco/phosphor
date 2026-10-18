import type { Hash } from 'node:crypto'
import { join } from 'node:path'

export interface AttachmentOwner {
  laneId: string
  clientId: string
  fence: number
}
export interface Upload extends AttachmentOwner {
  path: string
  name: string
  size: number
  received: number
  index: number
  started: number
  hash: Hash
}
export interface AttachmentPorts {
  directory: string
  laneExists(laneId: string): boolean
  log?: (event: string) => void
  now?: () => number
}
export interface AttachmentState {
  ports: AttachmentPorts
  root: string
  temporary: string
  uploads: Map<string, Upload>
  now: () => number
  timer: ReturnType<typeof setInterval> | undefined
}
export const laneIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const refusal = { ok: false, code: 'bad-request' } as const

export function createAttachmentState(ports: AttachmentPorts): AttachmentState {
  return {
    ports,
    root: join(ports.directory, 'attachments'),
    temporary: join(ports.directory, 'attachments-tmp'),
    uploads: new Map(),
    now: ports.now ?? Date.now,
    timer: undefined,
  }
}
