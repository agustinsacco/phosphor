import { Markdown } from '@/components/markdown/Markdown'

/** Markdown rendered in-app; `urlBase` is what its relative images resolve against. */
export function MarkdownPreview({
  text,
  urlBase,
}: {
  text: string
  urlBase?: string
}): React.JSX.Element {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-5">
        <Markdown text={text} urlBase={urlBase} />
      </div>
    </div>
  )
}
