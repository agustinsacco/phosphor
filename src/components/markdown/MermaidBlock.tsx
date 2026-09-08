import { memo, useEffect, useId, useState } from 'react'
import { useSettingsStore } from '@/stores/settings'
import { CodeBlock } from './CodeBlock'
import { Lightbox } from '../Lightbox'
import { errorText } from '@shared/errors'

let mermaidCounter = 0

export const MermaidBlock = memo(function MermaidBlock({
  code,
}: {
  code: string
}): React.JSX.Element {
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')

  useEffect(() => {
    let cancelled = false
    setError(null)
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        // Phosphor theme variables (docs/style-guide.md) instead of the
        // built-in neutral/dark themes, so diagrams read as Phosphor surfaces.
        const dark = resolvedTheme === 'dark'
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          themeVariables: {
            darkMode: dark,
            background: dark ? '#2a2721' : '#ffffff',
            primaryColor: dark ? '#3d3220' : '#f6e9d4',
            primaryTextColor: dark ? '#ece7db' : '#26262a',
            primaryBorderColor: dark ? '#4b453a' : '#c9c9ce',
            secondaryColor: dark ? '#26231e' : '#efeff1',
            tertiaryColor: dark ? '#322e27' : '#f7f7f8',
            lineColor: dark ? '#aca496' : '#66666e',
            textColor: dark ? '#ece7db' : '#26262a',
            noteBkgColor: dark ? '#322e27' : '#f2f2f4',
            noteTextColor: dark ? '#ece7db' : '#26262a',
          },
          fontFamily: 'var(--px-font-sans)',
          securityLevel: 'strict',
        })
        const id = `mmd-${reactId}-${mermaidCounter++}`
        const result = await mermaid.render(id, code)
        if (!cancelled) setSvg(result.svg)
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, resolvedTheme, reactId])

  if (error) {
    return (
      <div>
        <CodeBlock code={code} language="mermaid" />
        <div className="text-danger -mt-2 mb-3 px-1 text-base">Mermaid parse error: {error}</div>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="border-border bg-surface my-3 flex h-32 animate-pulse items-center justify-center rounded-lg border">
        <span className="text-text-tertiary text-base">Rendering diagram…</span>
      </div>
    )
  }

  return (
    <>
      <div
        className="mermaid-svg border-border bg-surface my-3 cursor-zoom-in overflow-x-auto rounded-lg border p-4 [&_svg]:mx-auto [&_svg]:max-w-full"
        onClick={() => setZoomed(true)}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {zoomed && (
        <Lightbox onClose={() => setZoomed(false)}>
          <div
            className="max-h-[90vh] max-w-[90vw] overflow-auto rounded-lg bg-white p-6 [&_svg]:h-auto [&_svg]:w-full"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </Lightbox>
      )}
    </>
  )
})
