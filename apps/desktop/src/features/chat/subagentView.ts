import { validTargetId } from '@phosphor/pi-extensions/subagent-snapshot'
import type { FleetNode, FleetSnapshot } from './subagentRuns'

export interface SubagentTarget {
  runId: string
  childId?: string
}
export interface SubagentView {
  view: 'live' | 'history'
  target?: SubagentTarget
}
const KEY = 'phosphor-subagent-view-v1'

export function loadSubagentView(sessionId: string): SubagentView {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')[sessionId]
    const t = raw?.target
    return {
      view: raw?.view === 'history' ? 'history' : 'live',
      ...(validTargetId(t?.runId) && (t.childId === undefined || validTargetId(t.childId))
        ? { target: { runId: t.runId, ...(t.childId === undefined ? {} : { childId: t.childId }) } }
        : {}),
    }
  } catch {
    return { view: 'live' }
  }
}

/** UI preferences only. Bounded, keyed by Pi's durable session ID, with no cached liveness. */
export function saveSubagentView(sessionId: string, value: SubagentView): void {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const prior = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    delete prior[sessionId]
    localStorage.setItem(
      KEY,
      JSON.stringify(Object.fromEntries([...Object.entries(prior).slice(-99), [sessionId, value]])),
    )
  } catch {
    /* A lost preference must not prevent inspection. */
  }
}

export function selectedFleetNode(
  fleet: FleetSnapshot | null,
  target: SubagentTarget | undefined,
): FleetNode | undefined {
  if (!target) return
  const root = fleet?.runs.find((node) => node.id === target.runId)
  if (!target.childId) return root
  const find = (nodes: FleetNode[]): FleetNode | undefined => {
    for (const node of nodes) {
      if (node.id === target.childId) return node
      const child = find(node.children)
      if (child) return child
    }
  }
  return root && find(root.children)
}
