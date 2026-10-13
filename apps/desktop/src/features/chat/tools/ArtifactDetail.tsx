import { TooltipButton } from '@/components/Tooltip'
import type { ToolState } from '../reducer'
import { toolDetails, toolText } from './toolSummaries'
import { ErrorText } from './toolDetails'
import { artifactGlyph } from '@/features/artifacts/artifactKinds'
import {
  normalizeArtifactType,
  useArtifactsStore,
  type ArtifactToolDetails,
} from '@/stores/artifacts'
import { useLayoutStore } from '@/stores/layout'
import { formatBytes } from '@/lib/format'

/**
 * Detail view for `artifact_create` / `artifact_update` / `artifact_edit`.
 *
 * The generic view was actively unhelpful here: an artifact's whole payload is
 * one giant `content` argument, so it rendered a wall of raw JSON above a
 * one-line "Created artifact" result, and the *useful* action — look at the
 * thing — lived in a pane the user had to find. This card carries the identity
 * (glyph, title, type, version) and makes opening it the primary action.
 */
export function ArtifactDetail({
  tool,
  sessionId,
}: {
  tool: ToolState
  sessionId: string
}): React.JSX.Element {
  const details = toolDetails<ArtifactToolDetails>(tool)
  const running = tool.status === 'starting' || tool.status === 'running'
  const known = useArtifactsStore((s) =>
    details?.id ? s.bySession[sessionId]?.[details.id] : undefined,
  )

  if (tool.isError) return <ErrorText text={toolText(tool)} />

  // Still streaming: the payload is the content field, so bytes-so-far is the
  // only honest progress indicator we have.
  if (running || !details?.id) {
    return (
      <div
        data-find-skip
        className="text-text-secondary flex items-center gap-2 px-3 py-2.5 text-base"
      >
        <span className="bg-accent tool-running-dot h-1.5 w-1.5 shrink-0 rounded-full" />
        <span className="tool-running-label">Writing artifact content</span>
        {tool.argsText && (
          <span className="text-text-tertiary font-mono text-sm">
            {formatBytes(tool.argsText.length)}
          </span>
        )}
      </div>
    )
  }

  const artifactId = details.id
  // The store's metadata wins: pre-fix artifact_update payloads carry the sentinel
  // type 'update' and default their title to the slug id, so trusting the
  // payload rendered wrong glyph/type/title on every completed update card.
  const type = known?.type ?? normalizeArtifactType(details.type)
  const title = known?.title ?? details.title ?? artifactId
  const version = details.version ?? known?.versions.length
  const size = details.content ? formatBytes(details.content.length) : undefined

  const open = (): void => {
    // Navigate to the version THIS card represents, not just the artifact.
    useArtifactsStore.getState().select(sessionId, artifactId, version)
    useArtifactsStore.getState().clearUnseen(sessionId)
    useLayoutStore.getState().setRightPane('artifacts')
  }

  return (
    <TooltipButton
      tooltip="Open artifact"
      onClick={open}
      className="hover:bg-bg-secondary/60 flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
    >
      <span data-find-skip className="text-xl leading-none">
        {artifactGlyph(type)}
      </span>
      <span className="min-w-0 flex-1">
        {/* Skipped by find: the step's own row already names the artifact. */}
        <span data-find-skip className="text-text block truncate text-lg font-medium">
          {title}
        </span>
        <span data-find-skip className="text-text-tertiary block text-sm">
          {type}
          {version != null && ` · v${version}`}
          {size && ` · ${size}`}
        </span>
      </span>
      <span
        data-find-skip
        className="border-border text-text-secondary shrink-0 rounded-md border px-2 py-1 text-sm font-medium"
      >
        Open in panel
      </span>
    </TooltipButton>
  )
}
