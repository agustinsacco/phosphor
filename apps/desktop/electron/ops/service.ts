import { app } from 'electron'
import { join } from 'node:path'
import { AGENT_OPS_SCHEMA, createAuditLog } from '@phosphor/session-runtime/ops/audit'
import { confirmPort, createConfirmStore } from '@phosphor/session-runtime/ops/confirm'
import { createOpsDispatcher } from '@phosphor/session-runtime/ops/dispatcher'
import { argsSummary } from '@phosphor/session-runtime/ops/redact'
import { createUndo, type UndoPorts } from '@phosphor/session-runtime/ops/undo'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import { OP_GAPS } from '@phosphor/shared/ops-catalog'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { policyStore } from '../prefs/agent-policy'
import { metaHandlers, settingsHandlers } from './meta'
import { brainHandlers } from './brain'
import { conversationHandlers } from './conversation'
import { inventoryHandlers } from './inventory'
import { controlHandlers, markHandlers, deferred } from './controls'
import { liveOpLane, liveOpRef, resolveLiveLane, findDiskLane } from './lanes'
import { activeDesktopOps, installDesktopOps } from './lifecycle'
import type { OpsBinding } from '@phosphor/session-runtime/ops/types'

const isCurrent: UndoPorts['isCurrent'] = async (entry) => {
  const ref = entry.target
  const args = entry.undoRecord.forward
  if (!ref || !args) return false
  const lane = resolveLiveLane(ref) ?? (await findDiskLane(ref))
  if (!lane) return false
  if (entry.op === 'lane.rename') return args.name === lane.title
  if (!lane.path) return false
  const prefs = (await import('../store')).getPrefs()
  if (entry.op === 'lane.pin') return args.on === prefs.pinnedSessions.includes(lane.path)
  if (entry.op === 'lane.marker') return args.marker === prefs.laneMarkers[lane.path]
  return false
}
const notify: OpsBinding['notifySurfaces'] = (event) =>
  broadcast('ops:changed', { machine: 'local', ...event })
export function openDesktopOps(userData: string) {
  const db = new (loadSqlite().DatabaseSync)(join(userData, 'agent-ops.sqlite'))
  try {
    db.exec(AGENT_OPS_SCHEMA)
    const audit = createAuditLog(db)
    const confirms = createConfirmStore()
    const changed = () => notify({ kind: 'confirm' })
    const handlers = {
      ...metaHandlers(audit, confirms, changed),
      ...settingsHandlers(policyStore, notify, (p, id) => dispatcher.undo(p, id)),
      ...controlHandlers,
      ...markHandlers,
      ...inventoryHandlers,
      ...conversationHandlers,
      ...brainHandlers,
    }
    const binding: OpsBinding = {
      machineId: null,
      handlers,
      gaps: OP_GAPS.desktop,
      flags: new Set(['laneContext', 'pagedLanes']),
      policy: policyStore,
      audit,
      lanes: { resolve: resolveLiveLane, lookup: findDiskLane, createdBy: () => null },
      deferred,
      notifySurfaces: notify,
    }
    const dispatcher = createOpsDispatcher(binding, {
      parseArgv: (argv, content) => parseOpArgv(argv, undefined, { content }),
      agentFor: (id) => {
        const laneRef = liveOpRef(id)
        const lane = liveOpLane(id)
        return lane && laneRef
          ? {
              kind: 'agent',
              sessionId: id,
              laneRef,
              lineage: 0,
              unattended: lane.unattended,
            }
          : null
      },
      surfaceAdmits: (p) => p.via === 'owner',
      confirms: confirmPort(confirms, changed),
      redact: argsSummary,
      undo: { run: (principal, id) => undo(principal, id) },
      log,
    })
    const undo = createUndo({ audit, isCurrent, run: (p, r) => dispatcher.run(p, r) })
    return { dispatcher, handlers, close: () => db.close() }
  } catch (error) {
    db.close()
    throw error
  }
}
/** Lazy: E2E redirects userData before the first lane op. */
export function desktopOps() {
  const existing = activeDesktopOps()
  if (existing) return existing
  const opened = openDesktopOps(app.getPath('userData'))
  installDesktopOps(opened.dispatcher)
  app.once('will-quit', opened.close)
  return opened.dispatcher
}
