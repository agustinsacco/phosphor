import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { stripAnsi } from '@shared/ansi'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from '@/features/chat/composer/contextBreakdown'
import { MCP_INSPECTION_STATUS_KEY } from '@shared/mcp-inspection'
import { LANE_RELOAD_STATUS_KEY } from '@phosphor/pi-extensions/lane-reload'
import { SWARM_STATUS_KEY } from '@phosphor/pi-extensions/swarm'
import { RATE_LIMIT_STATUS_KEY } from '@/features/chat/composer/rateLimit'
import { HEADROOM_STATUS_KEY } from '@/features/chat/composer/headroomStatus'
import {
  SUBAGENTS_STATUS_KEY,
  parseSubagentStatus,
  summarizeSubagents,
} from '@/features/chat/subagentStatus'
// From its one home, not the chat re-export: the status-wire audit resolves Set literals one hop deep.
import {
  SUBAGENT_ASYNC_WIDGET_KEY,
  parseFleetWidget,
  summarizeFleet,
} from '@phosphor/shared/subagent-fleet'
import { useChatStore } from '@/stores/chat'
import { openSubagents } from '@/features/chat/subagentView'
import { AnsiText } from './AnsiText'

/**
 * Machine payloads belong to their consumers, never the human status strip.
 * Includes native MCP inspection replies correlated by main's session service.
 */
const STRUCTURED_STATUS_KEYS = new Set([
  CONTEXT_BREAKDOWN_STATUS_KEY,
  RATE_LIMIT_STATUS_KEY,
  SUBAGENTS_STATUS_KEY,
  HEADROOM_STATUS_KEY,
  // Main's reply channel for a between-turns reload; never for the user.
  LANE_RELOAD_STATUS_KEY,
  MCP_INSPECTION_STATUS_KEY,
  SWARM_STATUS_KEY,
])

/**
 * Sub-agents as a chip: how many are out there, and what the newest one is
 * doing right now.
 *
 * Two sources, one chip. Sessions on pi-subagents (both providers) publish
 * their background runs on the `subagent-async` widget, which the extension
 * removes once nothing runs. Sessions recorded on the Claude Code provider
 * before 0.9.0 published `claude-subagents`, cleared at the end of the
 * episode (0.4.14; never on older providers, which is why that chip can say
 * "done"). Either way the chip is live state: the transcript's own rows are
 * what remain.
 */
function SubagentChip({
  sessionId,
  available,
}: {
  sessionId: string
  available: boolean
}): React.JSX.Element | null {
  const statusText = useExtensionUiStore((s) => s.statuses[sessionId]?.[SUBAGENTS_STATUS_KEY])
  const fleetLines = useExtensionUiStore(
    (s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines,
  )
  const fleet = parseFleetWidget(fleetLines)
  const legacy = fleet ? null : parseSubagentStatus(statusText)
  if (!legacy && !fleet && !available) return null
  const active = legacy ? legacy.active > 0 : (fleet?.active ?? 0) > 0
  const title = legacy
    ? legacy.tasks.map((task) => `${task.description || task.taskId}: ${task.status}`).join('\n')
    : (fleet?.runs.map((run) => `${run.label}: ${run.state}`).join('\n') ??
      'Recorded delegation and child inspection')
  return (
    <>
      <TooltipButton
        data-testid="subagent-chip"
        aria-label="Open subagents"
        disabled={!!legacy && !available}
        onClick={() => openSubagents(sessionId)}
        title={title}
        className="text-text-tertiary flex min-w-0 items-center gap-1.5 text-xs"
      >
        <span
          className={clsx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            active ? 'bg-accent' : 'bg-text-tertiary/50',
          )}
        />
        <span className="truncate">
          {legacy ? summarizeSubagents(legacy) : fleet ? summarizeFleet(fleet) : 'Subagents'}
        </span>
      </TooltipButton>
    </>
  )
}

/** Status strip entries for a session (extension setStatus). */
export function StatusStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const statuses = useExtensionUiStore((s) => s.statuses[sessionId])
  const hasFleet = useExtensionUiStore(
    (s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY] !== undefined,
  )
  const available = useChatStore((s) => {
    const session = s.sessions[sessionId]
    return (
      !!session &&
      (session.commands.some(
        (c) =>
          c.source === 'extension' &&
          (c.name === 'subagents' || c.name === 'subagents-inspect-rpc'),
      ) ||
        Object.values(session.tools).some((t) => t.toolName === 'subagent'))
    )
  })
  if (!statuses && !hasFleet && !available) return null
  const entries = Object.entries(statuses ?? {}).filter(([key]) => !STRUCTURED_STATUS_KEYS.has(key))
  const hasAgents = available || hasFleet || statuses?.[SUBAGENTS_STATUS_KEY] !== undefined
  if (entries.length === 0 && !hasAgents) return null
  return (
    <div className="border-border bg-bg-secondary/60 flex h-6 shrink-0 items-center gap-3 border-t px-3">
      <SubagentChip sessionId={sessionId} available={available} />
      {entries.map(([key, text]) => (
        <span
          key={key}
          data-tooltip={stripAnsi(text)}
          className="text-text-tertiary flex min-w-0 items-center gap-1.5 text-xs"
        >
          <span className="bg-info h-1.5 w-1.5 shrink-0 rounded-full" />
          <span className="truncate">
            <AnsiText text={text} />
          </span>
        </span>
      ))}
    </div>
  )
}
