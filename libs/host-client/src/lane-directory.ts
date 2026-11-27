import {
  HOST_LIMITS,
  type HostFrame,
  type HostResourceChange,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { HostConnectionSnapshot } from './connection'

type Attention = Extract<HostFrame, { type: 'attention' }>
type DirectoryView = Pick<HostConnectionSnapshot, 'cursor' | 'lanes' | 'repositories'>

interface LaneDirectoryPorts {
  view: () => DirectoryView
  update: (next: Partial<DirectoryView>) => void
  setCursor: (cursor: StreamCursor) => void
  resubscribe: () => void
  laneLimit: () => void
  onResourceChanged?: (change: HostResourceChange) => void
  onRoutinesChanged?: () => void
  onAttention?: (event: Attention['event']) => void
}

/** Projects frames from the `lanes` topic, independently of individual lane watches. */
export function createLaneDirectory(ports: LaneDirectoryPorts) {
  const attention: Attention[] = []
  function receive(f: HostFrame): boolean {
    if (!('id' in f) || f.id !== 'lanes') return false
    const view = ports.view()
    const cursor = view.cursor
    if (f.type === 'lanes') {
      if (cursor?.epoch !== f.cursor.epoch) attention.length = 0
      ports.update({
        repositories: [...f.repositories],
        lanes: [...f.lanes],
        cursor: {
          epoch: f.cursor.epoch,
          seq: cursor?.epoch === f.cursor.epoch ? Math.max(cursor.seq, f.cursor.seq) : f.cursor.seq,
        },
      })
    } else if (f.type === 'resource-changed') {
      ports.onResourceChanged?.(f.change)
    } else if (f.type === 'routines-changed') {
      if (cursor?.epoch !== f.cursor.epoch || f.cursor.seq <= cursor.seq) return true
      if (f.cursor.seq !== cursor.seq + 1) ports.resubscribe()
      // Only the routines surface changed; do not invalidate every Host query.
      ports.setCursor(f.cursor)
      ports.onRoutinesChanged?.()
    } else if (f.type === 'lanes-delta' || f.type === 'attention') {
      if (cursor?.epoch !== f.cursor.epoch) return true
      if (f.type === 'attention') {
        if (!attention.some((a) => a.event.id === f.event.id)) {
          attention.push(f)
          ports.onAttention?.(f.event)
        }
        attention.sort((a, b) => a.cursor.seq - b.cursor.seq)
        if (attention.length > 50) attention.shift()
        // The attention callback may have advanced the view before this update.
        ports.update({
          cursor: { epoch: f.cursor.epoch, seq: Math.max(ports.view().cursor!.seq, f.cursor.seq) },
        })
      } else {
        if (f.cursor.seq <= cursor.seq) return true
        if (f.cursor.seq !== cursor.seq + 1) {
          ports.resubscribe()
          return true
        }
        const lanes = new Map(view.lanes.map((l) => [l.laneId, l]))
        for (const id of f.remove) lanes.delete(id)
        for (const l of f.upsert) lanes.set(l.laneId, l)
        if (lanes.size > HOST_LIMITS.lanesPerHost) {
          ports.laneLimit()
          return true
        }
        ports.update({ lanes: [...lanes.values()], cursor: f.cursor })
      }
    } else return false
    return true
  }
  return {
    receive,
    attention: () => structuredClone(attention),
    clearAttention: () => {
      attention.length = 0
    },
  }
}
