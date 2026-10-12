import { useMemo, useState } from 'react'
import { Button } from '@/components/form'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { SubagentPanel } from '@/features/chat/SubagentPanel'
import { summarizeTool } from '@/features/chat/tools/toolSummaries'
import {
  fleetCurrentTool,
  parseFleetWidget,
  SUBAGENT_ASYNC_WIDGET_KEY,
  summarizeFleet,
} from '@/features/chat/subagentRuns'
import type { WorkbenchLane } from './laneState'

/** A bounded preview, never a second transcript or an inspector polling in the background. */
export function LaneActivity({ lane }: { lane: WorkbenchLane }): React.JSX.Element {
  const sessionId = lane.phosphorId
  const chat = useChatStore((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const lines = useExtensionUiStore((s) =>
    sessionId ? s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines : undefined,
  )
  const question = useExtensionUiStore(
    (s) => s.dialogs.find((d) => d.sessionId === sessionId)?.request.title,
  )
  const fleet = useMemo(() => parseFleetWidget(lines), [lines])
  const [inspecting, setInspecting] = useState(false)
  const tool = chat ? Object.values(chat.tools).at(-1) : undefined
  const summary = tool ? summarizeTool(tool, lane.workspacePath) : undefined
  return (
    <div className="mt-4 space-y-3 text-base">
      {question && (
        <p className="border-accent bg-accent-soft line-clamp-3 border-l-2 px-3 py-2">{question}</p>
      )}
      <div className="bg-bg-secondary rounded-md p-3">
        <div className="text-text-secondary mb-1 font-mono text-xs uppercase tracking-wider">
          {chat?.error ? 'Session error' : summary ? 'Latest tool' : 'Activity'}
        </div>
        <p className="line-clamp-2 break-words">
          {chat?.error ??
            (summary
              ? `${tool?.status === 'error' ? 'Failed · ' : ''}${summary.label} ${summary.object ?? ''}${summary.hint ? ` · ${summary.hint}` : ''}`
              : chat?.isCompacting
                ? 'Compacting context'
                : chat?.isStreaming
                  ? 'Agent is working'
                  : chat?.promptSentAt
                    ? 'Waiting for the agent'
                    : 'Open the lane to read its conversation.')}
        </p>
      </div>
      {fleet && (
        <div className="border-border border-t pt-3">
          <p className="text-text-secondary mb-2 text-sm">{summarizeFleet(fleet)}</p>
          <ul className="border-border space-y-1 border-l pl-3">
            {fleet.runs.slice(-3).map((run) => (
              <li key={run.id} className="flex min-w-0 gap-2">
                <span className="min-w-0 flex-1 truncate" title={run.label}>
                  {run.label}
                </span>
                <span className="text-text-secondary shrink-0 font-mono text-sm">{run.state}</span>
                {fleetCurrentTool(run) && (
                  <span className="text-text-secondary max-w-24 truncate text-sm">
                    {fleetCurrentTool(run)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {(fleet.incomplete || fleet.runs.length > 3) && (
            <p className="text-text-secondary mt-2 text-sm">
              Partial preview · inspect for more detail
            </p>
          )}
          <Button size="xs" className="mt-2" onClick={() => setInspecting(true)}>
            View subagents
          </Button>
        </div>
      )}
      {inspecting && sessionId && (
        <SubagentPanel sessionId={sessionId} onClose={() => setInspecting(false)} />
      )}
    </div>
  )
}
