import { ansiToSpans } from '@shared/ansi'

/**
 * Extension-authored text styled with ANSI SGR codes, rendered as colored
 * runs. pi extensions style for pi's own TUI; we honor foreground colors and
 * drop everything else rather than letting escape bytes reach the DOM.
 */
export function AnsiText({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {ansiToSpans(text).map((span, i) =>
        span.color ? (
          <span key={i} style={{ color: span.color }}>
            {span.text}
          </span>
        ) : (
          <span key={i}>{span.text}</span>
        ),
      )}
    </>
  )
}
