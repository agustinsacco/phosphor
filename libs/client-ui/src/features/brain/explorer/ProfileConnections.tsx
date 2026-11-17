import { useEffect, useRef, useState } from 'react'
import {
  BRAIN_PREDICATE_LABELS,
  type BrainConnection,
  type BrainConnectionGroup,
  type BrainEntityView,
} from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { KindDot } from './KnowledgePrimitives'

/** One row per predicate label; one button per neighbour. Hover lights its edge on the map. */
export function ProfileConnections({
  view,
  onEntity,
  onHover,
}: {
  view: BrainEntityView
  onEntity: (id: string, label: string) => void
  onHover: (id: string | null) => void
}): React.JSX.Element {
  if (!view.groups.length)
    return (
      <p className="text-text-tertiary py-3 text-sm">
        No connections yet. They appear when a read says how {view.entity.label} relates to someone
        or something else.
      </p>
    )
  return (
    <table aria-label="Connections" className="w-full table-fixed border-collapse text-sm">
      <tbody>
        {view.groups.map((group) => (
          <ConnectionRow
            key={`${group.direction}:${group.predicate}`}
            id={view.entity.id}
            group={group}
            onEntity={onEntity}
            onHover={onHover}
          />
        ))}
      </tbody>
    </table>
  )
}

function ConnectionRow({
  id,
  group,
  onEntity,
  onHover,
}: {
  id: string
  group: BrainConnectionGroup
  onEntity: (id: string, label: string) => void
  onHover: (id: string | null) => void
}): React.JSX.Element {
  const { items, next, error, loading, more } = useConnectionPages(id, group)
  const label = BRAIN_PREDICATE_LABELS[group.predicate][group.direction]
  return (
    <tr className="border-border border-b align-top">
      <th scope="row" className="text-text-secondary w-32 py-2 pr-3 text-left font-medium">
        {label}
        <span className="text-text-tertiary ml-1 font-normal">{group.total}</span>
      </th>
      <td className="py-1.5">
        <div className="flex flex-wrap gap-1" onMouseLeave={() => onHover(null)}>
          {items.map((item) => (
            <Neighbour key={item.link.id} item={item} onEntity={onEntity} onHover={onHover} />
          ))}
        </div>
        {error && (
          <p role="status" className="pt-1">
            {error}
          </p>
        )}
        {next && (
          <Button size="xs" className="mt-1" disabled={loading} onClick={more}>
            {loading ? 'Loading…' : error ? 'Retry' : 'Show more'}
          </Button>
        )}
      </td>
    </tr>
  )
}

function Neighbour({
  item,
  onEntity,
  onHover,
}: {
  item: BrainConnection
  onEntity: (id: string, label: string) => void
  onHover: (id: string | null) => void
}): React.JSX.Element {
  const { entity } = item
  return (
    <TooltipButton
      tooltip={`Go to ${entity.label}`}
      className="bg-chip hover:bg-bg-secondary inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md px-2 py-0.5 text-left [overflow-wrap:anywhere]"
      onMouseEnter={() => onHover(entity.id)}
      onFocus={() => onHover(entity.id)}
      onBlur={() => onHover(null)}
      onClick={() => onEntity(entity.id, entity.label)}
    >
      <KindDot kind={entity.kind} />
      <span className="min-w-0">{entity.label}</span>
      <span className="text-text-tertiary shrink-0">
        {formatCount(item.supports, 'memory', 'memories')}
      </span>
    </TooltipButton>
  )
}

/** The group's first page from the view, then `brain:connections` pages on demand. */
function useConnectionPages(id: string, group: BrainConnectionGroup) {
  const [items, setItems] = useState(group.items)
  const [next, setNext] = useState(group.next)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // A reloaded view (Brain changed) starts the group again from its first page.
  useEffect(() => {
    setItems(group.items)
    setNext(group.next)
    setError('')
  }, [group])
  const load = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const page = await window.phosphor.invoke(
        'brain:connections',
        id,
        group.predicate,
        group.direction,
        next,
      )
      if (!alive.current) return
      setItems((old) => [...new Map([...old, ...page.items].map((c) => [c.link.id, c])).values()])
      setNext(page.next)
    } catch (cause) {
      if (alive.current) setError(ipcErrorText(cause))
    } finally {
      if (alive.current) setLoading(false)
    }
  }
  return {
    items,
    next,
    error,
    loading,
    more: () => {
      void load()
    },
  }
}
