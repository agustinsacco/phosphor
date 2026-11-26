import type { CatalogSpec } from '@phosphor/shared/ops-catalog'
import { laneCall } from './lane-target'
import type { DaemonHandlerDeps } from './index'

/** Use the machine's own feature router, after ops admission. */
export async function resourceCall(
  deps: DaemonHandlerDeps,
  method: string,
  params: unknown,
  signal?: AbortSignal,
) {
  return laneCall(deps.lanes, method, params, signal, () => !signal?.aborted)
}

export const NO_CONTENT_UNDO = "No Undo: Phosphor doesn't keep the previous content."

/** Daemon implementations which may outlast one answer deadline; none has a safe inverse. */
const RESOURCE_JOBS: ReadonlyMap<string, CatalogSpec['applies']> = new Map([
  ['skill.install', 'new-lanes'],
  ['routine.cancel', 'now'],
  ['routine.delete', 'now'],
])
export function resourceJobSpec(spec: CatalogSpec): CatalogSpec {
  const applies = RESOURCE_JOBS.get(spec.name)
  return applies ? { ...spec, applies, job: true } : spec
}
