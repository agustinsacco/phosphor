import type { AuditLog } from '@phosphor/session-runtime/ops/audit'
import type { ConfirmStore } from '@phosphor/session-runtime/ops/confirm'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { requestPage } from '@phosphor/session-runtime/ops/ports'
import { renderHelp } from '@phosphor/shared/ops-cli'
import { OP_CATALOG, OP_GAPS } from '@phosphor/shared/ops-catalog'
import { op, dataResult } from './results'

export function metaHandlers(audit: AuditLog, store: ConfirmStore, changed: () => void) {
  function info(r: ReturnType<ConfirmStore['info']>) {
    if (!r.ok)
      throw new OpRefusal(r.code === 'confirm-mismatch' ? 'confirm-expired' : r.code, r.text)
    if (r.info.state === 'expired')
      throw new OpRefusal('confirm-expired', 'This confirmation expired.')
    return dataResult(r.info)
  }
  return {
    help: op<{ topic?: string }>(({ topic }) => ({
      text: renderHelp(
        OP_CATALOG.filter((s) => !OP_GAPS.desktop[s.name]),
        topic,
      ),
    })),
    whoami: op((_a, c) => dataResult({ machine: 'This Mac', principal: c.principal })),
    'audit.list': op<{ lane?: string; limit?: number }>(async ({ lane, limit = 50 }, ctx) => {
      const rows = await audit.list({ laneRef: lane, beforeId: requestPage(ctx), limit: limit + 1 })
      const shown = rows.slice(0, limit)
      return {
        ...dataResult(shown),
        ...(rows.length > limit ? { next: shown[shown.length - 1]!.id } : {}),
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
