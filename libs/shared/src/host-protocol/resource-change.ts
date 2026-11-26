import { isUuid } from '../control-api'
import type { HostFrame } from './frames'
import { frameId, member, record } from './primitives'

export const HOST_RESOURCE_KINDS = [
  'archives',
  'settings',
  'connectors',
  'skills',
  'packages',
  'artifacts',
  'routines',
  'folders',
  'sandboxes',
] as const

export interface HostResourceChange {
  readonly kind: (typeof HOST_RESOURCE_KINDS)[number]
  readonly laneId?: string
  readonly repositoryId?: string
}

/** No resource contents travel here. The receiver reads under its regular grant. */
export function parseResourceChangedFrame(
  value: Record<string, unknown>,
): Extract<HostFrame, { type: 'resource-changed' }> | null {
  const { id, change } = value
  if (!frameId(id) || !record(change)) return null
  const { kind, laneId, repositoryId } = change
  if (
    !member(kind, HOST_RESOURCE_KINDS) ||
    (laneId !== undefined && !isUuid(laneId)) ||
    (repositoryId !== undefined &&
      (typeof repositoryId !== 'string' || !/^[0-9a-f]{16}$/.test(repositoryId)))
  )
    return null
  return {
    type: 'resource-changed',
    id,
    change: { kind, ...(laneId ? { laneId } : {}), ...(repositoryId ? { repositoryId } : {}) },
  }
}
