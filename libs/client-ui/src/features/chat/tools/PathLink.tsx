import { useSessionFileTarget } from '@/features/files/SessionFileTarget'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { TooltipButton } from '@/components/Tooltip'
import { openFileInWorkspace } from '@/stores/layout'
import { getActiveWorkspace } from '@/stores/workspaces'

/** Clickable path chip: opens the file in the Files pane (optionally at a line). */
export function PathLink({ path, line }: { path: string; line?: number }): React.JSX.Element {
  const sessionId = useSessionFileTarget()
  const open = (): void => {
    const workspacePath = sessionId
      ? useSessionsStore.getState().live[sessionId]?.workspacePath
      : getActiveWorkspace()
    if (workspacePath)
      void openFileInWorkspace(workspacePath, path, line, sessionId ?? undefined).catch(() =>
        useExtensionUiStore.getState().pushToast('File is unavailable.', 'error'),
      )
  }
  return (
    <TooltipButton
      onClick={open}
      title={line !== undefined ? `Open at line ${line}` : 'Open in Files pane'}
      className="text-text hover:text-accent truncate text-left font-mono text-base underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
    >
      {path}
    </TooltipButton>
  )
}

/**
 * One tool execution as a collapsed row (screenshot style) that expands to a
 * tool-specific detail view. Unknown/extension tools use the generic branch.
 */
