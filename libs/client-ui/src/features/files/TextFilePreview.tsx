import { lazy, Suspense, useState } from 'react'
import clsx from 'clsx'
import { isTextPreview, previewKindForPath } from '@shared/file-kinds'
import { TooltipButton } from '@/components/Tooltip'
import type { PendingReveal } from '@/stores/files'

// The renderers bring the markdown stack and the theme store; a Files pane loads them on use.
const TextFileRender = lazy(() => import('./TextFileRender'))

export type FileView = 'preview' | 'source'

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

/**
 * A Host file that is also renderable (Markdown, HTML, SVG), drawn from the text already read.
 * It opens on Preview, as This Mac's viewer does, and a reveal is a place in its source.
 */
export function TextFilePreview({
  path,
  content,
  reveal,
  source,
}: {
  path: string
  content: string
  reveal?: PendingReveal
  source: React.ReactNode
}): React.JSX.Element {
  const [choice, setChoice] = useState<{ path: string; seq?: number; view: FileView }>()
  const kind = isTextPreview(path) ? previewKindForPath(path) : null
  if (!kind) return <>{source}</>
  const seq = reveal?.seq
  const view =
    choice?.path === path && choice.seq === seq
      ? choice.view
      : seq === undefined
        ? 'preview'
        : 'source'
  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-8 shrink-0 items-center border-b px-2">
        <ViewTabs view={view} onChange={(next) => setChoice({ path, seq, view: next })} />
      </div>
      <div className="min-h-0 flex-1">
        {view === 'source' ? (
          source
        ) : (
          <Suspense fallback={null}>
            <TextFileRender kind={kind} path={path} content={content} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
