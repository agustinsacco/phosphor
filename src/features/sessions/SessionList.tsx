import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { useSessionsStore } from '@/stores/sessions'
import { moveSession, orderedSessions } from './sessionOrder'

const OrderActions = createContext<ContextMenuItem[]>([])
export const useSessionOrderActions = (): ContextMenuItem[] => useContext(OrderActions)

/** Native drag preview; only two DOM attributes change on hover, never the session tree. */
export function SessionList({
  items,
  disabled = false,
}: {
  items: { id: string; path?: string; content: ReactNode }[]
  disabled?: boolean
}): React.JSX.Element {
  const order = useSessionsStore((s) => s.sessionOrder)
  const sorted = orderedSessions(items, order)
  const paths = sorted.flatMap((item) => (item.path ? [item.path] : []))
  const drag = useRef<{ path: string; node: HTMLElement } | null>(null)
  const target = useRef<HTMLElement | null>(null)
  const frame = useRef(0)
  const blocked = useRef(false)
  const [announcement, announce] = useState('')
  const clearTarget = (): void => {
    if (target.current) delete target.current.dataset.drop
    target.current = null
    cancelAnimationFrame(frame.current)
  }
  const finish = (): void => {
    clearTarget()
    if (drag.current) delete drag.current.node.dataset.dragging
    drag.current = null
  }
  useEffect(() => {
    window.addEventListener('blur', finish)
    return () => {
      window.removeEventListener('blur', finish)
      finish()
    }
  }, [])
  useEffect(() => {
    if (disabled) finish()
  }, [disabled])

  const commit = (source: string, destination: string, after: boolean): void => {
    const next = moveSession(paths, source, destination, after)
    if (next === paths) return
    useSessionsStore.getState().setSessionOrder(next)
    announce(`Session moved to position ${next.indexOf(source) + 1} of ${next.length}`)
  }

  return (
    <div
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) clearTarget()
      }}
    >
      <span className="sr-only" role="status">
        {announcement}
      </span>
      {sorted.map(({ id, path, content }) => {
        const index = path ? paths.indexOf(path) : -1
        const actions: ContextMenuItem[] = ['up', 'down'].map((direction, offset) => ({
          label: `Move ${direction}`,
          shortcut: offset ? 'Alt+↓' : 'Alt+↑',
          disabled: disabled || index < 0 || (offset ? index === paths.length - 1 : index === 0),
          onClick: () => {
            const destination = paths[index + (offset ? 1 : -1)]
            if (path && destination) commit(path, destination, Boolean(offset))
          },
        }))
        return (
          <OrderActions.Provider key={id} value={actions}>
            <div
              className="session-sort-row relative"
              data-session-path={path}
              draggable={Boolean(path) && !disabled}
              title={disabled ? undefined : 'Drag to reorder · Alt+↑ / Alt+↓ to move'}
              onPointerDownCapture={(event) => {
                blocked.current = Boolean(
                  (event.target as Element).closest('input, [role="checkbox"], [role="link"]'),
                )
              }}
              onKeyDownCapture={(event) => {
                if (
                  !event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  (event.target as Element).closest('input') ||
                  !['ArrowUp', 'ArrowDown'].includes(event.key)
                )
                  return
                event.preventDefault()
                event.stopPropagation()
                const action = actions[event.key === 'ArrowDown' ? 1 : 0]!
                if (!action.disabled) action.onClick()
              }}
              onDragStart={(event) => {
                if (
                  !path ||
                  disabled ||
                  blocked.current ||
                  event.currentTarget.querySelector('input, [data-deleting="true"]')
                ) {
                  event.preventDefault()
                  return
                }
                event.stopPropagation()
                drag.current = { path, node: event.currentTarget }
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('application/x-phosphor-session', path)
                event.currentTarget.dataset.dragging = 'true'
              }}
              onDragOver={(event) => {
                if (!drag.current || !path || disabled) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                clearTarget()
                const node = event.currentTarget
                const rect = node.getBoundingClientRect()
                const after = event.clientY > rect.top + rect.height / 2
                if (moveSession(paths, drag.current.path, path, after) !== paths) {
                  target.current = node
                  node.dataset.drop = after ? 'after' : 'before'
                }
                const scroll = node.closest<HTMLElement>('[data-session-scroll]')
                if (!scroll) return
                const bounds = scroll.getBoundingClientRect()
                const y = event.clientY
                const speed = y < bounds.top + 36 ? -6 : y > bounds.bottom - 36 ? 6 : 0
                if (speed) {
                  const tick = (): void => {
                    scroll.scrollTop += speed
                    frame.current = requestAnimationFrame(tick)
                  }
                  frame.current = requestAnimationFrame(tick)
                }
              }}
              onDrop={(event) => {
                if (!drag.current || !path || disabled) return
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                commit(drag.current.path, path, event.clientY > rect.top + rect.height / 2)
                finish()
              }}
              onDragEnd={finish}
            >
              {content}
            </div>
          </OrderActions.Provider>
        )
      })}
    </div>
  )
}
