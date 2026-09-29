import { memo } from 'react'
import clsx from 'clsx'
import type { ToolState } from '../reducer'
import { isToolActive, ompTaskView, summarizeTool } from './toolSummaries'
import { ChevronIcon } from '@/components/icons'
import {
  BashDetail,
  DiffStatBadges,
  EditDetail,
  GenericDetail,
  ListDetail,
  ReadDetail,
  WriteDetail,
} from './toolDetails'
import { ArtifactDetail } from './ArtifactDetail'
import { OmpTaskDetail, SubagentDetail } from './SubagentDetail'
import { useSessionsStore } from '@/stores/sessions'

export const ToolCard = memo(function ToolCard({
  tool,
  sessionId,
  expanded,
  onToggle,
}: {
  tool: ToolState
  sessionId: string
  /** Owned by the row (ActivityGroup) so the detail can render full-width
   *  below it instead of as a nested card inside this one. */
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  // The session's own cwd, not the globally active workspace — transcripts
  // outlive session switches. Used to strip long (worktree) path prefixes
  // out of bash command labels; the expanded detail keeps the full command.
  const workspacePath = useSessionsStore((s) => s.live[sessionId]?.workspacePath ?? undefined)
  const summary = summarizeTool(tool, workspacePath)
  const running = isToolActive(tool)
  const failed = tool.status === 'error'

  return (
    // `.tool-card` has no CSS behind it — it is the selector the e2e density
    // test (e2e/smoke.spec.ts "rows are dense and sit flush") measures rows
    // by. Load-bearing: renaming it turns that test into a confusing red run.
    <div className="tool-card">
      <button
        onClick={onToggle}
        className={clsx(
          'group flex w-full items-center gap-1.5 py-1 text-left text-lg transition-colors',
          failed ? 'text-danger' : 'text-text-secondary hover:text-text',
        )}
      >
        <span className={clsx('shrink-0', running && 'tool-running-label')}>{summary.label}</span>
        {/* The spaces between the parts are for find, which reads this line as
            "Ran npm test"; the flex row does not render them. */}
        {summary.object && (
          <>
            {' '}
            <span
              className={clsx(
                'truncate font-medium',
                failed ? 'text-danger' : 'text-text',
                summary.mono && 'font-mono text-base',
              )}
            >
              {summary.object}
            </span>
          </>
        )}
        {summary.stats && <DiffStatBadges stats={summary.stats} className="text-base" />}
        {summary.hint && (
          <>
            {' '}
            <span className="text-text-tertiary shrink-0 font-mono text-sm">{summary.hint}</span>
          </>
        )}
        {failed && (
          <>
            {' '}
            <span className="bg-danger-soft text-danger shrink-0 rounded px-1.5 py-px text-xs font-medium">
              failed
            </span>
          </>
        )}
        {/*
         * The in-flight dot TRAILS the label. Leading it made every row jump
         * 12px sideways the moment the tool settled and the dot went away —
         * and the rows are now aligned tightly enough for that to read as a
         * glitch. It stays (rather than leaving the shimmer to carry it alone)
         * because prefers-reduced-motion turns the shimmer off.
         */}
        {running && (
          <span
            aria-hidden
            className="bg-accent tool-running-dot h-1.5 w-1.5 shrink-0 rounded-full"
          />
        )}
        <ChevronIcon expanded={expanded} className="text-text-tertiary" />
      </button>
    </div>
  )
})

export function ToolDetail({
  tool,
  sessionId,
}: {
  tool: ToolState
  sessionId: string
}): React.JSX.Element {
  switch (tool.toolName) {
    case 'bash':
      return <BashDetail tool={tool} />
    case 'edit':
      return <EditDetail tool={tool} />
    case 'write':
      return <WriteDetail tool={tool} />
    case 'read':
      return <ReadDetail tool={tool} />
    case 'grep':
    case 'find':
    case 'ls':
      return <ListDetail tool={tool} />
    case 'artifact_create':
    case 'artifact_update':
    case 'artifact_edit':
      return <ArtifactDetail tool={tool} sessionId={sessionId} />
    case 'subagent':
      return <SubagentDetail tool={tool} />
    case 'task': {
      const omp = ompTaskView(tool)
      return omp ? <OmpTaskDetail tool={tool} view={omp} /> : <GenericDetail tool={tool} />
    }
    default:
      return <GenericDetail tool={tool} />
  }
}

// ---------- per-tool detail views ----------
