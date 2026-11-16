import { useMemo } from 'react'
import clsx from 'clsx'
import { usePlatform } from '@/platform/Platform'
import { unifiedLines } from './unifiedLines'

/** Monaco's comparison on wide screens; a wrapping, single-column line diff on a phone. */
export function ResponsiveDiff({
  original,
  modified,
  editor,
}: {
  original: string
  modified: string
  editor: React.ReactNode
}): React.JSX.Element {
  return usePlatform().formFactor === 'compact' ? (
    <UnifiedLineDiff original={original} modified={modified} />
  ) : (
    <>{editor}</>
  )
}

function UnifiedLineDiff({
  original,
  modified,
}: {
  original: string
  modified: string
}): React.JSX.Element {
  const lines = useMemo(() => unifiedLines(original, modified), [original, modified])
  return (
    <div aria-label="Unified diff" className="p-2 font-mono text-sm">
      {original === modified && <p className="text-text-tertiary mb-2 font-sans">No changes</p>}
      {lines.map((line, index) => (
        <div
          key={index}
          className={clsx(
            'flex whitespace-pre-wrap break-words',
            line.kind === 'added' && 'bg-success/10 text-success',
            line.kind === 'removed' && 'bg-danger/10 text-danger',
          )}
        >
          <span
            className="w-5 shrink-0 select-none"
            aria-label={
              line.kind === 'added' ? 'Added' : line.kind === 'removed' ? 'Removed' : 'Unchanged'
            }
          >
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
          </span>
          <span className="min-w-0 flex-1">{line.text || '\u00a0'}</span>
        </div>
      ))}
    </div>
  )
}
