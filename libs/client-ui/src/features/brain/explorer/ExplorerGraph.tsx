import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BrainGraph, BrainLink } from '@shared/brain'
import { Button, NeutralSegmented } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { useBrainResource } from '../useBrainResource'
import { BrainGraph3D } from '../BrainGraph3D'
import type { BrainVisit } from './trail'
import { combineGraphs, includePath } from './graphProjection'

interface ExplorerGraphProps {
  entityId: string | null
  memoryId?: string | null
  label?: string
  path: BrainLink[] | null
  onVisit: (visit: BrainVisit) => void
  onClear?: () => void
}
export function ExplorerGraph({
  entityId,
  memoryId = null,
  label,
  path,
  onVisit,
  onClear,
}: ExplorerGraphProps): React.JSX.Element {
  const [scope, setScope] = useState('all')
  const [hops, setHops] = useState<'1' | '2'>('1')
  const selected = !!(entityId || memoryId)
  useEffect(() => {
    if (!selected) setScope('all')
  }, [selected])
  const { overview, resource, shown, memory, matches, error } = useExplorerGraph(
    entityId,
    memoryId,
    scope,
    hops,
    path,
  )
  return (
    <section aria-label="Graph explorer" className="flex h-full min-h-0 min-w-0 flex-col">
      {(!overview.data || !resource.data) && (
        <p role="status" className="p-2 text-sm">
          {error || 'Loading graph…'}
          {error && (
            <Button onClick={overview.error ? overview.retry : resource.retry}>Retry</Button>
          )}
        </p>
      )}
      {shown && (
        <>
          {shown.truncated && (
            <p className="text-text-tertiary p-2 text-sm">
              Showing a bounded selection of the graph. Search to explore further.
            </p>
          )}
          <BrainGraph3D
            graph={shown}
            path={path ?? memory?.links ?? null}
            focus={entityId}
            scope={scope === 'near' ? 'near' : 'all'}
            matches={matches}
            onClear={onClear}
            onFocus={(id) =>
              onVisit({
                kind: 'entity',
                id,
                label: shown.nodes.find((n) => n.id === id)?.label ?? id,
              })
            }
            toolbar={
              <GraphSelection
                selected={selected}
                label={label ?? entityId ?? 'Memory'}
                scope={scope}
                setScope={setScope}
                hops={hops}
                setHops={setHops}
                onClear={onClear}
              />
            }
          />
        </>
      )}
    </section>
  )
}
function GraphSelection({
  selected,
  label,
  scope,
  setScope,
  hops,
  setHops,
  onClear,
}: {
  selected: boolean
  label: string
  scope: string
  setScope: (value: string) => void
  hops: '1' | '2'
  setHops: (value: '1' | '2') => void
  onClear?: () => void
}): React.JSX.Element {
  if (!selected)
    return <span className="text-text-tertiary text-sm">Click a node to select it.</span>
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="bg-chip flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-sm">
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        <TooltipButton
          aria-label="Clear selection"
          tooltip="Clear selection · Esc"
          className="text-text-tertiary hover:text-text shrink-0 px-1"
          onClick={onClear}
        >
          ✕
        </TooltipButton>
      </span>
      <NeutralSegmented
        wrap
        value={scope}
        options={[
          { id: 'all', label: 'Whole graph' },
          { id: 'near', label: 'Neighbours only' },
        ]}
        onChange={setScope}
      />
      {scope === 'near' && (
        <NeutralSegmented
          wrap
          value={hops}
          options={[
            { id: '1', label: '1 step' },
            { id: '2', label: '2 steps' },
          ]}
          onChange={setHops}
        />
      )}
    </div>
  )
}

function useExplorerGraph(
  entityId: string | null,
  memoryId: string | null,
  scope: string,
  hops: '1' | '2',
  path: BrainLink[] | null,
) {
  const overview = useBrainResource(useCallback(() => window.phosphor.invoke('brain:overview'), []))
  const load = useCallback(async () => {
    const memory = memoryId ? await window.phosphor.invoke('brain:memory', memoryId) : null
    const ids = entityId ? [entityId] : (memory?.memory.entityIds ?? [])
    const near = scope === 'near' && ids.length > 0
    const missing = near ? ids : ids.filter((id) => !overview.data!.nodes.some((n) => n.id === id))
    const extras = await Promise.all(
      missing.map((id) =>
        window.phosphor.invoke('brain:neighbourhood', id, near ? (Number(hops) as 1 | 2) : 1),
      ),
    )
    const route = path ?? memory?.memory.links ?? null
    const graphs = near ? extras : [overview.data!, ...extras]
    const neighbours = graphs
      .flatMap((g) => g.links)
      .flatMap((link) =>
        ids.includes(link.subjectId)
          ? [link.objectId]
          : ids.includes(link.objectId)
            ? [link.subjectId]
            : [],
      )
    const priority = [
      ...ids,
      ...(route?.flatMap((l) => [l.subjectId, l.objectId]) ?? []),
      ...neighbours,
    ]
    const base = near || extras.length ? combineGraphs(graphs, priority) : overview.data!
    const graph = await includePath(base, route, priority)
    return { graph, memory }
  }, [entityId, memoryId, scope, hops, overview.data, path])
  const resource = useBrainResource(load, !!overview.data)
  const [previous, setPrevious] = useState<BrainGraph | null>(null)
  useEffect(() => {
    if (resource.data) setPrevious(resource.data.graph)
  }, [resource.data])
  const shown = resource.data?.graph ?? previous ?? overview.data
  const memory = resource.data?.memory?.memory
  const matches = useMemo(() => (memory ? new Set(memory.entityIds) : null), [memory])
  const error = overview.error || resource.error
  return { overview, resource, shown, memory, matches, error }
}
