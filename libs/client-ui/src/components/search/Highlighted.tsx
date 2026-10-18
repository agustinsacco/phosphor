import { useMemo } from 'react'
import { highlightRanges } from '@/lib/modelSearch'

/**
 * `text` with the parts `query` matched emphasised: the model picker's rows,
 * settings search results. For React-rendered text only; content React does
 * not own is painted by `domFind` instead.
 */
export function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  const ranges = useMemo(() => highlightRanges(text, query), [text, query])
  if (ranges.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let at = 0
  for (const [index, range] of ranges.entries()) {
    if (range.start > at) parts.push(text.slice(at, range.start))
    parts.push(
      <mark key={index} className="text-accent bg-transparent font-semibold">
        {text.slice(range.start, range.end)}
      </mark>,
    )
    at = range.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
