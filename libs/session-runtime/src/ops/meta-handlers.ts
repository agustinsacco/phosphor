/**
 * The meta ops every owner serves the same way: help, whoami, the audit list,
 * the user's confirmation answers, and the surface-only policy change and
 * Undo. Desktop in-app and the daemon bind these over their own stores.
 * Living contract: docs/agent-control.md.
 */
import { parseAgentPolicy } from '@phosphor/shared/ops'
import { renderHelp } from '@phosphor/shared/ops-cli'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import type { AuditLog } from './audit'
import { OpRefusal } from './builtins'
import type { ConfirmStore } from './confirm'
import { requestPage } from './ports'
import { dataResult, op } from './results'
import type { OpPrincipal, OpsBinding, OpsDispatcher, PolicyStore } from './types'

export interface MetaOwner {
  /** Ops this owner answers `unsupported`; help leaves them out. */
  readonly gaps: OpsBinding['gaps']
  /** The machine as `whoami` names it. */
  readonly machine: string
  /** What `whoami` shows of the caller; the principal itself when absent. */
  readonly shownPrincipal?: (principal: OpPrincipal) => unknown
}

export function metaHandlers(
  audit: AuditLog,
  store: ConfirmStore,
  changed: () => void,
  owner: MetaOwner,
) {
  function info(r: ReturnType<ConfirmStore['info']>) {
    if (!r.ok)
      throw new OpRefusal(r.code === 'confirm-mismatch' ? 'confirm-expired' : r.code, r.text)
    if (r.info.state === 'expired')
      throw new OpRefusal('confirm-expired', 'This confirmation expired.')
    return dataResult(r.info)
  }
  const shown = owner.shownPrincipal ?? ((principal: OpPrincipal) => principal)
  return {
    help: op<{ topic?: string }>(({ topic }) => ({
      text: renderHelp(
        OP_CATALOG.filter((s) => !owner.gaps[s.name]),
        topic,
      ),
    })),
    whoami: op((_a, c) => dataResult({ machine: owner.machine, principal: shown(c.principal) })),
    'audit.list': op<{ lane?: string; limit?: number }>(async ({ lane, limit = 50 }, ctx) => {
      const rows = await audit.list({ laneRef: lane, beforeId: requestPage(ctx), limit: limit + 1 })
      const shownRows = rows.slice(0, limit)
      return {
        ...dataResult(shownRows),
        ...(rows.length > limit ? { next: shownRows[shownRows.length - 1]!.id } : {}),
      }
    }),
    'confirm.list': op((_a, c) => {
      const r = store.list(c.principal)
      if (!r.ok) throw new OpRefusal(r.code, r.text)
      return dataResult(r.items)
    }),
    'confirm.info': op<Parameters<ConfirmStore['info']>[1]>((a, c) =>
      info(store.info(c.principal, a)),
    ),
    'confirm.approve': op<{ confirmId: string }>((a, c) => {
      const r = info(store.approve(c.principal, a.confirmId))
      changed()
      return r
    }),
    'confirm.deny': op<{ confirmId: string }>((a, c) => {
      const r = info(store.deny(c.principal, a.confirmId))
      changed()
      return r
    }),
  }
}

/** The catalog’s never tier admits only surfaces, whose capabilities the dispatcher checked. */
export function settingsHandlers(
  policy: PolicyStore,
  notify: OpsBinding['notifySurfaces'],
  undo: OpsDispatcher['undo'],
) {
  return {
    'policy.set': op(async (args) => {
      const parsed = parseAgentPolicy(args.policy)
      if (!parsed) throw new OpRefusal('bad-request', 'Invalid policy.')
      await policy.write(parsed)
      notify({ kind: 'policy' })
      return { text: 'Updated agent policy.' }
    }),
    'audit.undo': op<{ auditId: string }>(async ({ auditId }, ctx) => {
      const result = await undo(ctx.principal, auditId)
      if (result.status === 'denied') throw new OpRefusal(result.code, result.text)
      if (result.status !== 'ok') throw new OpRefusal('unavailable', 'Undo was not applied.')
      notify({ kind: 'audit' })
      return { text: result.text }
    }),
  }
}
