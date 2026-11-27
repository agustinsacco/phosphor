import { basename } from 'node:path'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { canonicalJson, sha256Hex } from '@phosphor/session-runtime/ops/redact'
import { fields, op, pageInventory } from '@phosphor/session-runtime/ops/results'
import { staleCleanup, type CleanupCandidate } from '../../features/sandbox-cleanup'
import type { DaemonHandlerDeps } from './index'

function cleanup(deps: DaemonHandlerDeps) {
  if (!deps.sandboxes?.cleanup) throw new OpRefusal('unavailable', 'Host cleanup is unavailable.')
  return deps.sandboxes.cleanup
}
const planId = (rows: readonly CleanupCandidate[]) => sha256Hex(canonicalJson(rows))

async function resolvePlan(deps: DaemonHandlerDeps, plan: string, signal?: AbortSignal) {
  const { rows } = await cleanup(deps).inspect(signal)
  if (!rows.length || planId(rows) !== plan) throw staleCleanup()
  return rows
}

export async function maintenanceTargets(
  deps: DaemonHandlerDeps,
  plan: string,
  signal?: AbortSignal,
) {
  return (await resolvePlan(deps, plan, signal)).map(({ path }) => basename(path))
}

export function maintenanceHandlers(deps: DaemonHandlerDeps) {
  return {
    'maintenance.scan': op(async (_, ctx) => {
      const { rows, skipped } = await cleanup(deps).inspect(ctx.signal)
      const plan = rows.length ? planId(rows) : null
      const page = pageInventory(rows, ctx, fields('kind', 'path', 'bytes', 'reason'), {
        wrap: (candidates) => ({ plan, candidates, skipped }),
      })
      return {
        ...page,
        text: `${plan ? `Plan ${plan} (${rows.length} targets)` : 'No eligible cleanup targets'}; skipped: ${JSON.stringify(skipped)}.\nOnly empty Host-registered sandboxes qualify.\n${page.text}`,
      }
    }),
    'maintenance.run': op<{ plan: string }>(async ({ plan }, ctx) => {
      const rows = await resolvePlan(deps, plan, ctx.signal)
      const result = await cleanup(deps).apply(rows, ctx.signal)
      return {
        text: `Removed ${result.removed} of ${rows.length} confirmed sandboxes.`,
        data: result,
        undo: false,
      }
    }),
  }
}
