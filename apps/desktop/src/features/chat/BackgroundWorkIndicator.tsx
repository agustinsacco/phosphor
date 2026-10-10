import { useState } from 'react'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionBooting } from './BootingIndicator'
import { SubagentPanel } from './SubagentPanel'
import {
  isFleetActive,
  parseFleetWidget,
  SUBAGENT_ASYNC_WIDGET_KEY,
  type FleetNode,
} from './subagentRuns'

/** Prefer active steps to their enclosing run, without counting both as agents. */
function activeTasks(nodes: FleetNode[]): FleetNode[] {
  return nodes.flatMap((node) => {
    const children = activeTasks(node.children)
    return children.length ? children : isFleetActive(node.state) ? [node] : []
  })
}

function needsAttention(nodes: FleetNode[]): boolean {
  return nodes.some(
    (node) => (isFleetActive(node.state) && node.attention) || needsAttention(node.children),
  )
}

/** Live extension evidence, not a continuation of the parent's finished turn. */
export function BackgroundWorkIndicator({ sessionId }: { sessionId: string }): React.JSX.Element {
  const lines = useExtensionUiStore((s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
  const parentRunning = useChatStore(
    (s) => !!(s.sessions[sessionId]?.isStreaming || s.sessions[sessionId]?.isCompacting),
  )
  const booting = useSessionBooting(sessionId)
  const [open, setOpen] = useState(false)
  const fleet = parseFleetWidget(lines)
  const visible = fleet && (fleet.active > 0 || fleet.incomplete)
  const tasks = activeTasks(fleet?.runs ?? [])
  const activity = tasks
    .slice(0, 3)
    .map((task) =>
      [
        `${task.label}: ${task.state}`,
        task.currentTool,
        task.attention ? 'needs parent attention' : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
    )
    .join('; ')
  const parentBusy = parentRunning || booting

  return (
    <>
      {visible && (
        <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="background-work-indicator">
          <div className="bg-bg-secondary border-border flex items-start gap-2 rounded-lg border px-3 py-2 text-base">
            {/* The parent's Starting/Working strip already owns the beacon while busy. */}
            {!parentBusy && <PhosphorLoader decorative animated={fleet.active > 0} />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <span className="text-text font-medium">
                  {fleet.active > 0 ? 'Working in the background' : 'Background status incomplete'}
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="text-text-secondary hover:text-text shrink-0 rounded px-1 py-0.5 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
                >
                  View subagents
                </button>
              </div>
              {activity && (
                <p className="text-text-secondary line-clamp-2 break-words" title={activity}>
                  {activity}
                  {tasks.length > 3 ? `; +${tasks.length - 3} more in inspection` : ''}
                </p>
              )}
              {fleet.incomplete && (
                <p className="text-text-secondary">
                  Snapshot incomplete; some work may not be shown.
                </p>
              )}
              <p className="text-text-secondary">
                {parentBusy
                  ? 'Messages still go to the parent, not a child.'
                  : 'The parent is idle. You can still message it.'}
                {needsAttention(fleet.runs) && ' Attention signals are for the parent.'}
              </p>
            </div>
          </div>
        </div>
      )}
      {/* Completion/removal must not close an inspection the user is reading. */}
      {open && (
        <SubagentPanel key={sessionId} sessionId={sessionId} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
