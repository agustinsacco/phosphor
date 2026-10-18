import { useSessionFileTarget } from '@/features/files/SessionFileTarget'
import { classifyLink, type LinkTarget } from '@/lib/markdownLink'
import { openFileInWorkspace } from '@/stores/layout'
import { getActiveWorkspace } from '@/stores/workspaces'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { openArtifact } from '@/stores/artifacts'
import { useSessionsStore } from '@/stores/sessions'

/**
 * A link in model-authored markdown. A web URL goes to the default browser; a
 * path the model wrote opens in the Files pane, at its line when it names one;
 * `artifact://<id>` opens that artifact in the Artifacts pane.
 *
 * An in-app link carries no `href` on purpose: with one, a middle-click or a
 * missed `preventDefault` navigates the whole app to a path that is not a
 * route, and the only way back is a reload.
 */
export function MarkdownLink({
  href,
  title,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element {
  const sourceSessionId = useSessionFileTarget()
  const target = href ? classifyLink(href) : ({ kind: 'none' } as const)

  const activate = (event: { preventDefault: () => void }): void => {
    event.preventDefault()
    if (target.kind === 'external') {
      void window.phosphor.invoke('app:openExternal', target.url)
      return
    }
    if (target.kind === 'artifact') {
      const sessionId = sourceSessionId ?? useSessionsStore.getState().activeSessionId
      if (sessionId && openArtifact(sessionId, target.id, target.version)) return
      useExtensionUiStore
        .getState()
        .pushToast(`No artifact "${target.id}" in this session`, 'error')
      return
    }
    if (target.kind !== 'file') return
    const workspacePath = sourceSessionId
      ? useSessionsStore.getState().live[sourceSessionId]?.workspacePath
      : getActiveWorkspace()
    if (!workspacePath) return
    void openFileInWorkspace(
      workspacePath,
      target.path,
      target.line,
      sourceSessionId ?? undefined,
    ).catch(() => {
      useExtensionUiStore
        .getState()
        .pushToast(
          (
            sourceSessionId
              ? useSessionsStore.getState().live[sourceSessionId]?.target?.kind === 'remote'
              : workspacePath.startsWith('host:')
          )
            ? 'File is unavailable.'
            : `Could not open ${target.path}`,
          'error',
        )
    })
  }

  const className = 'text-info hover:underline'
  if (target.kind === 'file' || target.kind === 'artifact') {
    return (
      <a
        {...rest}
        aria-description={title}
        role="link"
        tabIndex={0}
        data-tooltip={inAppTitle(target)}
        className={`${className} cursor-pointer`}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') activate(event)
        }}
      >
        {children}
      </a>
    )
  }

  return (
    <a
      href={href}
      {...rest}
      className={className}
      onClick={activate}
      data-tooltip={target.kind === 'external' ? 'Open in browser' : undefined}
      aria-description={title}
    >
      {children}
    </a>
  )
}

function inAppTitle(target: Extract<LinkTarget, { kind: 'file' | 'artifact' }>): string {
  if (target.kind === 'artifact') {
    return target.version === undefined
      ? 'Open in Artifacts pane'
      : `Open in Artifacts pane at v${target.version}`
  }
  return target.line === undefined
    ? 'Open in Files pane'
    : `Open in Files pane at line ${target.line}`
}
