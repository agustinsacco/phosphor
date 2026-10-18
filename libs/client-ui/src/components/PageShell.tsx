import { memo } from 'react'
import { useLayoutStore } from '@/stores/layout'
import { PaneIconButton } from '@/components/PaneShell'
import { CloseIcon } from '@/components/icons'

/**
 * Shared chrome for global pages (Artifacts, Skills): the full-main-region
 * surfaces opened from the sidebar, belonging to no session. Mirrors
 * PaneShell's slots (title left, actions, ✕ far right) but drops the
 * pane-only controls — a page has no side to swap and no split to expand.
 * ✕ returns to whatever the page covered: the active session or the home
 * screen.
 */
export const PageShell = memo(function PageShell({
  title,
  actions,
  children,
}: {
  title: React.ReactNode
  /** Page-specific controls, rendered between the title and ✕. */
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1.5 px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{title}</div>
        {actions}
        <PaneIconButton title="Close page" onClick={() => useLayoutStore.getState().setPage(null)}>
          <CloseIcon size={13} />
        </PaneIconButton>
      </div>
      {/* Flex column for the same reason as PaneShell: page bodies size
          themselves with `flex-1` + `overflow-y-auto`, which collapses to
          auto height unless this slot is a flex container. */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  )
})
