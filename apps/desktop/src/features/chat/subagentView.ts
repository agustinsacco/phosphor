import { create } from 'zustand'
import { useChatStore } from '@/stores/chat'
import { useLayoutStore } from '@/stores/layout'
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

// A navigation signal, not execution state. Bounded to the most recent request.
export const useSubagentNavigation = create(() => ({
  sessionId: '',
  revision: 0,
  runId: undefined as string | undefined,
  childId: undefined as string | undefined,
  toolCallId: undefined as string | undefined,
}))

export function openForegroundSubagent(sessionId: string, toolCallId: string): void {
  useSubagentNavigation.setState((s) => ({
    sessionId,
    toolCallId,
    runId: undefined,
    childId: undefined,
    revision: s.revision + 1,
  }))
  useLayoutStore.getState().setRightPane('subagents', sessionId)
}

/** All entry points open the same session pane; explicit links select an exact run. */
export function openSubagents(sessionId: string, runId?: string, childId?: string): void {
  const identity = useChatStore.getState().sessions[sessionId]?.meta?.sessionId
  if (runId) {
    if (identity) saveSubagentView(identity, { view: 'live', target: { runId, childId } })
    useSubagentNavigation.setState((s) => ({
      sessionId,
      revision: s.revision + 1,
      runId,
      childId,
      toolCallId: undefined,
    }))
  }
  useLayoutStore.getState().setRightPane('subagents', sessionId)
}

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
