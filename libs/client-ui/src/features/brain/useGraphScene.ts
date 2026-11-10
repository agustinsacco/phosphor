import { useEffect, useRef, useState } from 'react'
import type { GraphModel } from './graphModel'
import type { GraphScene, GraphSelection } from './graphScene'

function hasWebGL(): boolean {
  try {
    const context = document.createElement('canvas').getContext('webgl2')
    if (!context) return false
    context.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

export function useGraphScene(
  container: React.RefObject<HTMLDivElement | null>,
  model: GraphModel,
  selection: GraphSelection,
  onFocus: (id: string) => void,
): { scene: GraphScene | null; unavailable: boolean } {
  const [scene, setScene] = useState<GraphScene | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const focus = useRef(onFocus)
  const instance = useRef<GraphScene | null>(null)
  useEffect(() => {
    focus.current = onFocus
  }, [onFocus])
  useEffect(() => {
    const element = container.current!
    let disposed = false
    if (!hasWebGL()) {
      setUnavailable(true)
      return
    }
    import('./graphScene')
      .then(({ createGraphScene }) => {
        if (disposed) return
        instance.current = createGraphScene(element, (id) => focus.current(id))
        setScene(instance.current)
      })
      .catch(() => {
        if (!disposed) {
          element.replaceChildren()
          setUnavailable(true)
        }
      })
    return () => {
      disposed = true
      instance.current?.dispose()
      instance.current = null
      element.replaceChildren()
    }
  }, [container])
  useEffect(() => {
    try {
      scene?.update(model, { focus: selection.focus, matches: selection.matches })
    } catch {
      instance.current?.dispose()
      instance.current = null
      setScene(null)
      container.current?.replaceChildren()
      setUnavailable(true)
    }
  }, [scene, model, selection.focus, selection.matches, container])
  return { scene, unavailable }
}
