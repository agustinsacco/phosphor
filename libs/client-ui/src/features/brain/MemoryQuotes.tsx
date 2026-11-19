import type { BrainQuote } from '@shared/brain'

/** Quotes with their surrounding words, the matched part marked, and who said it where. */
export function MemoryQuotes({ quotes }: { quotes: BrainQuote[] }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {quotes.map((quote, index) => (
        <figure
          key={index}
          className="border-border border-l-2 pl-3 text-sm [overflow-wrap:anywhere]"
        >
          <blockquote>
            {quote.before}
            <mark className="bg-accent-soft text-text rounded-sm">{quote.quote}</mark>
            {quote.after}
          </blockquote>
          <figcaption className="text-text-tertiary mt-1">{quote.label}</figcaption>
        </figure>
      ))}
    </div>
  )
}
