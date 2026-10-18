import { usePlatform } from '@/platform/Platform'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ModalOverlay } from '../Modal'
import { Button } from '../form'
import { CopyButton } from '../CopyButton'
import { errorText } from '@shared/errors'
import { fitDiagram, zoomDiagram, type DiagramView } from './diagramViewport'

export function MermaidViewer({
  svg,
  code,
  onClose,
}: {
  svg: string
  code: string
  onClose: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const canvas = useRef<HTMLDivElement>(null)
  const drawing = useRef<HTMLDivElement>(null)
  const fit = useRef<DiagramView>({ scale: 1, x: 0, y: 0 })
  const [view, setView] = useState(fit.current)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const drag = useRef<{ id: number; x: number; y: number } | null>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    canvas.current?.focus()
    return () => previous?.focus()
  }, [])

  useLayoutEffect(() => {
    const viewport = canvas.current!
    const container = drawing.current!
    const image = container.querySelector('svg')!
    const box = image.viewBox.baseVal
    const width = box.width || image.getBoundingClientRect().width || 800
    const height = box.height || image.getBoundingClientRect().height || 600
    // Mermaid's inline max-width and percentage width constrain the lightbox.
    container.style.width = `${width}px`
    container.style.height = `${height}px`
    image.style.width = '100%'
    image.style.height = '100%'
    image.style.maxWidth = 'none'
    let previousSize = ''
    const resize = (): void => {
      const bounds = viewport.getBoundingClientRect()
      const size = `${bounds.width},${bounds.height}`
      if (size === previousSize) return
      previousSize = size
      fit.current = fitDiagram(width, height, bounds)
      setView(fit.current)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(viewport)
    resize()
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1)
      setView((current) =>
        zoomDiagram(
          current,
          Math.max(
            Math.min(0.1, fit.current.scale),
            Math.min(4, current.scale * Math.exp(-delta * 0.002)),
          ),
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
        ),
      )
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => {
      observer.disconnect()
      viewport.removeEventListener('wheel', wheel)
    }
  }, [svg])

  const zoom = (factor: number): void =>
    setView((current) =>
      zoomDiagram(
        current,
        Math.max(Math.min(0.1, fit.current.scale), Math.min(4, current.scale * factor)),
      ),
    )

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const image = drawing.current!.querySelector('svg')!.cloneNode(true) as SVGSVGElement
      // Export intrinsic dimensions, not the viewer's current zoom or app-only font variable.
      image.setAttribute('width', drawing.current!.style.width)
      image.setAttribute('height', drawing.current!.style.height)
      image.style.removeProperty('width')
      image.style.removeProperty('height')
      image.style.setProperty('--px-font-sans', 'Arial, sans-serif')
      image.style.background = getComputedStyle(canvas.current!).backgroundColor
      const content = new XMLSerializer().serializeToString(image)
      const path = await window.phosphor.invoke('app:saveDialog', {
        title: 'Save diagram',
        defaultPath: 'diagram.svg',
      })
      if (path) await window.phosphor.invoke('fs:writeFile', path, content)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose} backdrop="photo">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Mermaid diagram"
        className="bg-surface text-text border-border flex h-[90vh] w-[96vw] flex-col overflow-hidden rounded-lg border shadow-2xl"
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const stops = [
            ...event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), [tabindex="0"]',
            ),
          ]
          const index = stops.indexOf(document.activeElement as HTMLElement)
          event.preventDefault()
          stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus()
        }}
      >
        <div className="border-border flex flex-wrap items-center gap-2 border-b p-3">
          <span className="mr-auto font-medium">Mermaid diagram</span>
          <Button
            size="sm"
            aria-label="Zoom out"
            disabled={view.scale <= Math.min(0.1, fit.current.scale)}
            onClick={() => zoom(1 / 1.25)}
          >
            −
          </Button>
          <output aria-label="Zoom level" className="w-14 text-center text-sm tabular-nums">
            {Math.round(view.scale * 100)}%
          </output>
          <Button
            size="sm"
            aria-label="Zoom in"
            disabled={view.scale >= 4}
            onClick={() => zoom(1.25)}
          >
            +
          </Button>
          <Button size="sm" onClick={() => setView(fit.current)}>
            Fit
          </Button>
          <Button size="sm" onClick={() => setView({ scale: 1, x: 0, y: 0 })}>
            100%
          </Button>
          <CopyButton text={code} label="Copy source" />
          {platform.nativeFiles && (
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save SVG'}
            </Button>
          )}
          <Button size="sm" aria-label="Close diagram" onClick={onClose}>
            Close
          </Button>
        </div>
        <div
          ref={canvas}
          tabIndex={0}
          aria-label="Diagram canvas"
          className="bg-surface relative min-h-0 flex-1 touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          style={{ cursor: 'grab' }}
          onKeyDown={(event) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return
            const key = event.key
            if (key === '+' || key === '=') zoom(1.25)
            else if (key === '-') zoom(1 / 1.25)
            else if (key === '0') setView({ scale: 1, x: 0, y: 0 })
            else if (key.toLowerCase() === 'f') setView(fit.current)
            else if (key.startsWith('Arrow'))
              setView((v) => ({
                ...v,
                x: v.x + (key === 'ArrowLeft' ? 40 : key === 'ArrowRight' ? -40 : 0),
                y: v.y + (key === 'ArrowUp' ? 40 : key === 'ArrowDown' ? -40 : 0),
              }))
            else return
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || !event.isPrimary) return
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.style.cursor = 'grabbing'
            drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
          }}
          onPointerMove={(event) => {
            const start = drag.current
            if (!start || start.id !== event.pointerId) return
            const dx = event.clientX - start.x
            const dy = event.clientY - start.y
            drag.current = { id: start.id, x: event.clientX, y: event.clientY }
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
          onLostPointerCapture={(event) => {
            drag.current = null
            event.currentTarget.style.cursor = 'grab'
          }}
        >
          <div
            ref={drawing}
            className="pointer-events-none absolute left-1/2 top-1/2 select-none"
            style={{
              transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`,
            }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
        <div className="border-border text-text-tertiary border-t px-3 py-2 text-sm">
          Drag to pan · Scroll or pinch to zoom · + / − zoom · Arrows pan · F fit · 0 actual size ·
          Esc close
          {error && (
            <div role="alert" className="text-danger">
              Could not save diagram: {error}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
