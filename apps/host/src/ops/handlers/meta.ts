import type { AuditLog } from '@phosphor/session-runtime/ops/audit'
import type { ConfirmStore } from '@phosphor/session-runtime/ops/confirm'
import { explainJobs } from '@phosphor/session-runtime/ops/job-explain'
import { jobHandlers, type JobStore } from '@phosphor/session-runtime/ops/jobs'
import { metaHandlers, settingsHandlers } from '@phosphor/session-runtime/ops/meta-handlers'
import type {
  OpHandler,
  OpsBinding,
  OpsDispatcher,
  PolicyStore,
} from '@phosphor/session-runtime/ops/types'
import { OP_GAPS } from '@phosphor/shared/ops-catalog'
import { shownPrincipal } from '../binding'

export interface DaemonMetaPorts {
  /** How `whoami` names this machine. */
  readonly machine: string
  readonly audit: AuditLog
  readonly confirms: ConfirmStore
  /** A confirmation changed: surfaces refresh their pending list. */
  readonly changed: () => void
  readonly policy: PolicyStore
  readonly notify: OpsBinding['notifySurfaces']
  readonly undo: OpsDispatcher['undo']
  readonly jobs: Pick<JobStore, 'get' | 'list'>
}

/**
 * The daemon's meta ops: help, whoami, audit, confirmations, jobs, and the
 * user's policy change and Undo. `policy.show` and `confirm.status` are the
 * dispatcher's own.
 */
export function daemonMetaHandlers(ports: DaemonMetaPorts): Readonly<Record<string, OpHandler>> {
  return {
    ...metaHandlers(ports.audit, ports.confirms, ports.changed, {
      gaps: OP_GAPS.daemon,
      machine: ports.machine,
      shownPrincipal,
    }),
    ...settingsHandlers(ports.policy, ports.notify, ports.undo),
    ...explainJobs(jobHandlers(ports.jobs)),
  }
}
