import { memo, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/settings'
import { CodeBlock } from './CodeBlock'
import { errorText } from '@shared/errors'

export const VegaLiteBlock = memo(function VegaLiteBlock({
  code,
}: {
  code: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let finalize: (() => void) | null = null

    void (async () => {
      let spec: Record<string, unknown>
      try {
        spec = JSON.parse(code)
      } catch (err) {
        setError(`Invalid JSON: ${errorText(err)}`)
        return
      }
      try {
        const { default: vegaEmbed } = await import('vega-embed')
        if (disposed || !containerRef.current) return
        setError(null)
        const result = await vegaEmbed(containerRef.current, spec as never, {
          actions: { export: true, source: false, compiled: false, editor: false },
          theme: resolvedTheme === 'dark' ? 'dark' : undefined,
          renderer: 'svg',
          config: {
            background: 'transparent',
            font: 'Inter, ui-sans-serif, system-ui, sans-serif',
          },
        })
        finalize = () => result.finalize()
      } catch (err) {
        if (!disposed) setError(errorText(err))
      }
    })()

    return () => {
      disposed = true
      finalize?.()
    }
  }, [code, resolvedTheme])

  if (error) {
    return (
      <div>
        <CodeBlock code={code} language="vega-lite" />
        <div className="text-danger -mt-2 mb-3 px-1 text-base">Vega-Lite error: {error}</div>
      </div>
    )
  }

  return (
    <div className="border-border bg-surface my-3 overflow-x-auto rounded-lg border p-4">
      <div ref={containerRef} />
    </div>
  )
})
