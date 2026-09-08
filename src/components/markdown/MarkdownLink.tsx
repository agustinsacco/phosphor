import { classifyLink } from '@/lib/markdownLink'
import { openFileInWorkspace } from '@/stores/layout'
import { getActiveWorkspace } from '@/stores/workspaces'
import { useExtensionUiStore } from '@/stores/extensionUi'

/**
 * A link in model-authored markdown. A web URL goes to the default browser; a
 * path the model wrote opens in the Files pane, at its line when it names one.
 *
 * A file link carries no `href` on purpose: with one, a middle-click or a
 * missed `preventDefault` navigates the whole app to a path that is not a
 * route, and the only way back is a reload.
 */
export function MarkdownLink({
  href,
  children,
  ...rest
}: React.AnchorHTMLAttributes<HTMLAnchorElement>): React.JSX.Element {
  const target = href ? classifyLink(href) : ({ kind: 'none' } as const)

  const activate = (event: { preventDefault: () => void }): void => {
    event.preventDefault()
    if (target.kind === 'external') {
      void window.phosphor.invoke('app:openExternal', target.url)
      return
    }
    if (target.kind !== 'file') return
    const workspacePath = getActiveWorkspace()
    if (!workspacePath) return
    void openFileInWorkspace(workspacePath, target.path, target.line).catch(() => {
      useExtensionUiStore.getState().pushToast(`Could not open ${target.path}`, 'error')
    })
  }

  const className = 'text-info hover:underline'
  if (target.kind === 'file') {
    return (
      <a
        {...rest}
        role="link"
        tabIndex={0}
        title={
          target.line === undefined
            ? 'Open in Files pane'
            : `Open in Files pane at line ${target.line}`
        }
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
    <a href={href} {...rest} className={className} onClick={activate}>
      {children}
    </a>
  )
}
