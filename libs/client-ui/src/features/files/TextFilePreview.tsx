import { lazy } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import type { FileView } from '@/stores/files'

// The renderers bring the markdown stack and the theme store; a Files pane loads them on use.
export const TextFileRender = lazy(() => import('./TextFileRender'))

/** The Preview | Source switch for a file that is both text and renderable. */
export function ViewTabs({
  view,
  onChange,
}: {
  view: FileView
  onChange: (view: FileView) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="View">
      {(['preview', 'source'] as const).map((id) => (
        <TooltipButton
          key={id}
          onClick={() => onChange(id)}
          aria-pressed={view === id}
          className={clsx(
            'rounded-sm px-1.5 py-0.5 text-sm font-medium transition-colors',
            view === id ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:text-text',
          )}
        >
          {id === 'preview' ? 'Preview' : 'Source'}
        </TooltipButton>
      ))}
    </div>
  )
}
