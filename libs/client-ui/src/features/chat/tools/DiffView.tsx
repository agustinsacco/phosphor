import { TooltipButton } from '@/components/Tooltip'
import { memo, useContext, useMemo, useState } from 'react'
import clsx from 'clsx'
import { parseDisplayDiff, type DiffLine } from '../diff'
import { DetailRevealContext, useOpenOnReveal } from '../useTranscriptFind'

const COLLAPSE_THRESHOLD = 40

/** Colored line-by-line rendering of pi's display diff format. */
export const DiffView = memo(function DiffView({ diff }: { diff: string }): React.JSX.Element {
  const lines = useMemo(() => parseDisplayDiff(diff), [diff])
  const [expanded, setExpanded] = useState(false)
  // Find counts every line, so a hit in the diff unfolds all of it.
  useOpenOnReveal(useContext(DetailRevealContext), setExpanded, 'detail')

  const visible = expanded ? lines : lines.slice(0, COLLAPSE_THRESHOLD)
  const hidden = lines.length - visible.length

  return (
    <div className="overflow-x-auto font-mono text-base leading-[1.5]">
      <table className="w-full border-collapse">
        <tbody>
          {visible.map((line, i) => (
            <DiffRow key={i} line={line} />
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <TooltipButton
          data-find-skip
          onClick={() => setExpanded(true)}
          className="text-text-tertiary hover:text-text block w-full py-1.5 text-center text-sm transition-colors"
        >
          Show {hidden} more lines
        </TooltipButton>
      )}
    </div>
  )
})

function DiffRow({ line }: { line: DiffLine }): React.JSX.Element {
  return (
    <tr
      className={clsx(
        line.kind === 'add' && 'bg-success/12',
        line.kind === 'del' && 'bg-danger/10',
      )}
    >
      <td
        data-find-skip
        className={clsx(
          'w-10 select-none pr-2 text-right align-top text-sm tabular-nums',
          line.kind === 'add' && 'text-success',
          line.kind === 'del' && 'text-danger',
          line.kind === 'context' && 'text-text-tertiary',
        )}
      >
        {line.lineNo ?? ''}
      </td>
      <td
        data-find-skip
        className={clsx(
          'w-4 select-none text-center align-top',
          line.kind === 'add' && 'text-success',
          line.kind === 'del' && 'text-danger',
          line.kind === 'context' && 'text-text-tertiary',
        )}
      >
        {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ''}
      </td>
      <td className="whitespace-pre-wrap break-all align-top">{line.text}</td>
    </tr>
  )
}
