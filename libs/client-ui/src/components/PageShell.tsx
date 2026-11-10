import { memo } from 'react'
import { useLayoutStore } from '@/stores/layout'
import { useNavigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { PaneIconButton } from '@/components/PaneShell'
import { CloseIcon } from '@/components/icons'
import './PageShell.css'

/**
 * Shared page title/actions; native close uncovers a lane, browser close uses its router.
 * A phone reaches every page from its tab bar, so there is nothing under a page to close to.
 */
export const PageShell = memo(function PageShell({
  title,
  actions,
  children,
  dismissible = true,
  wide = false,
}: {
  title: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  dismissible?: boolean
  /** The header spans the page instead of the reading width, for full-width content. */
  wide?: boolean
}): React.JSX.Element {
  const { localLanes, formFactor } = usePlatform()
  const { location, navigate } = useNavigation()
  const close = (): void => {
    if (localLanes) useLayoutStore.getState().setPage(null)
    else navigate({ to: 'lanes', ...('machine' in location && { machine: location.machine }) })
  }
  return (
    <div className={wide ? 'page-shell page-shell--wide' : 'page-shell'}>
      <header className="page-shell-header">
        <h1 className="page-shell-title">{title}</h1>
        <div className="page-shell-actions">{actions}</div>
        {dismissible && formFactor !== 'compact' && (
          <PaneIconButton title="Close page" onClick={close}>
            <CloseIcon size={13} />
          </PaneIconButton>
        )}
      </header>
      <div className="page-shell-content">{children}</div>
    </div>
  )
})
