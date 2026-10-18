import { memo, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/settings'
import { CodeBlock } from './CodeBlock'
import { errorText } from '@shared/errors'

/**
 * ```chart blocks — Chart.js config JSON: { type, data, options? }.
 * Invalid specs fall back to the code block with an error note.
 */
export const ChartBlock = memo(function ChartBlock({ code }: { code: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let chart: { destroy: () => void } | null = null

    void (async () => {
      let spec: Record<string, unknown>
      try {
        spec = JSON.parse(code)
      } catch (err) {
        setError(`Invalid JSON: ${errorText(err)}`)
        return
      }
      try {
        const { Chart, registerables } = await import('chart.js')
        Chart.register(...registerables)
        if (disposed || !canvasRef.current) return

        // Phosphor text-secondary / border (docs/style-guide.md).
        const textColor = resolvedTheme === 'dark' ? '#aca496' : '#66666e'
        const gridColor = resolvedTheme === 'dark' ? '#3a352c' : '#e4e4e7'
        Chart.defaults.color = textColor
        Chart.defaults.borderColor = gridColor
        Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif'

        setError(null)
        const config = {
          type: spec.type,
          data: spec.data,
          options: {
            responsive: true,
            maintainAspectRatio: false,
            ...(spec.options as object | undefined),
          },
        }
        chart = new Chart(canvasRef.current, config as never)
      } catch (err) {
        if (!disposed) setError(errorText(err))
      }
    })()

    return () => {
      disposed = true
      chart?.destroy()
    }
  }, [code, resolvedTheme])

  if (error) {
    return (
      <div>
        <CodeBlock code={code} language="chart" />
        <div className="text-danger -mt-2 mb-3 px-1 text-base">Chart error: {error}</div>
      </div>
    )
  }

  return (
    <div className="border-border bg-surface my-3 h-72 rounded-lg border p-4">
      <canvas ref={canvasRef} />
    </div>
  )
})
