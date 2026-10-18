import {
  HOST_LIMITS,
  type LaneSnapshot,
  type LaneSummary,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { SessionPush } from '@phosphor/shared/models'
import type { LaneProjection } from '@phosphor/session-runtime/lanes/projection'
import { createProjectionDialogs } from './projection-host/dialogs'
import { createProjectionRefresh, type ProjectionRefreshOptions } from './projection-host/refresh'

const SNAPSHOT_BYTES = HOST_LIMITS.outboundFrameBytes - 64 * 1024
export type SnapshotResult =
  { ok: true; snapshot: LaneSnapshot } | { ok: false; reason: 'too-large' }

type ProjectionHostState = {
  projection: LaneProjection
  refresh: ReturnType<typeof createProjectionRefresh>
  dialogs: ReturnType<typeof createProjectionDialogs>
}

function dispose(host: ProjectionHostState) {
  host.refresh.stop()
  host.dialogs.dispose()
}

function deliver(host: ProjectionHostState, push: SessionPush) {
  // resync is Desktop-local; a Host runtime never produces it.
  if (push.kind === 'stderr' || push.kind === 'resync' || host.refresh.isStopped()) return
  host.refresh.advanceRevision()
  host.projection.apply(push)
  if (push.kind === 'exit') {
    dispose(host)
  } else if (push.kind === 'event') {
    if (push.event.type === 'compaction_end') void host.refresh.refresh()
    else if (push.event.type === 'agent_end') void host.refresh.refresh(false)
  } else {
    host.dialogs.deliver(push.request)
  }
}

export function createHostLaneProjection(
  options: ProjectionRefreshOptions & {
    summary: () => LaneSummary
    cursor: () => StreamCursor
  },
) {
  const host: ProjectionHostState = {
    projection: options.projection,
    refresh: createProjectionRefresh(options),
    dialogs: createProjectionDialogs(options.projection),
  }
  return {
    refresh: host.refresh.refresh,
    dispose: () => dispose(host),
    stateChanged: () => host.refresh.refresh(false),
    deliver: (push: SessionPush) => deliver(host, push),
    resolveDialog: host.dialogs.resolve,
    snapshot(): SnapshotResult {
      return fitSnapshot({
        ...options.projection.view(),
        summary: options.summary(),
        cursor: options.cursor(),
      })
    },
  }
}

export function fitSnapshot(input: LaneSnapshot): SnapshotResult {
  let snapshot = input
  let bytes = Buffer.byteLength(JSON.stringify(snapshot))
  if (bytes <= SNAPSHOT_BYTES) return { ok: true, snapshot }
  // Elide only in the delivered copy, oldest first. pi's transcript is unchanged.
  const messages = structuredClone(snapshot.messages)
  snapshot = { ...snapshot, messages }
  for (const message of messages) {
    if (!('content' in message) || !Array.isArray(message.content)) continue
    for (const [index, block] of message.content.entries()) {
      if (block.type !== 'image') continue
      const omitted = {
        type: 'text' as const,
        text: `[image omitted: ${Math.ceil(Buffer.byteLength(block.data) / 1024)} KB]`,
      }
      bytes += Buffer.byteLength(JSON.stringify(omitted)) - Buffer.byteLength(JSON.stringify(block))
      message.content[index] = omitted
      if (bytes <= SNAPSHOT_BYTES) return { ok: true, snapshot }
    }
  }
  return { ok: false, reason: 'too-large' }
}
