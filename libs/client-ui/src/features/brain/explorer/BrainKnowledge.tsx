import { useCallback } from 'react'
import type { BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { ListDetail } from '@/components/ListDetail'
import { BrainMemoryDetail } from '../BrainMemory'
import { useBrainResource } from '../useBrainResource'
import { BrainSearch } from './BrainSearch'
import { BrainEntity } from './BrainEntity'
import { BrainTrail } from './BrainTrail'
import { ExplorerGraph } from './ExplorerGraph'
import type { BrainVisit } from './trail'
import type { ExplorerState } from './useExplorer'

export function BrainKnowledge({
  state,
  onOpenRead,
}: {
  state: ExplorerState
  /** Show the read that produced a memory: the Lanes tab opens on that job. */
  onOpenRead: (jobId: string) => void
}): React.JSX.Element {
  const { visit, onVisit } = state
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrainTrail trail={state.trail} onMove={state.move} onJump={state.jump} />
      <ListDetail
        listLabel="Brain Explorer"
        detailLabel="Brain graph"
        open={false}
        onBack={() => state.move(-1)}
        backLabel="Explorer"
        list={
          <>
            <div className="p-3">
              <BrainSearch shortcut onSelect={onVisit} onQuery={state.setQuery} />
            </div>
            {visit?.kind === 'entity' ? (
              <BrainEntity key={visit.id} id={visit.id} onVisit={onVisit} onPath={state.setPath} />
            ) : visit?.kind === 'memory' ? (
              <BrainMemoryDetail
                key={visit.id}
                id={visit.id}
                onFocus={(id, label) => onVisit({ kind: 'entity', id, label })}
                onMemory={(id, label) => onVisit({ kind: 'memory', id, label })}
                onForget={() => state.move(-1)}
                onExtraction={onOpenRead}
              />
            ) : (
              <p className="text-text-tertiary p-3 text-sm">
                Find a person, project or memory, or choose a node in the overview. Follow
                connections to explore what Brain knows.
              </p>
            )}
          </>
        }
        detail={() =>
          visit?.kind === 'memory' ? (
            <MemoryGraph id={visit.id} path={state.path} onVisit={onVisit} />
          ) : (
            <ExplorerGraph entityId={visit?.id ?? null} path={state.path} onVisit={onVisit} />
          )
        }
      />
    </div>
  )
}
function MemoryGraph({
  id,
  path,
  onVisit,
}: {
  id: string
  path: BrainLink[] | null
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:memory', id), [id])
  const { data, error, retry } = useBrainResource(load)
  if (!data)
    return (
      <p role="status" className="p-3">
        {error || 'Loading memory graph…'}
        {error && <Button onClick={retry}>Retry</Button>}
      </p>
    )
  return <ExplorerGraph entityId={data.memory.entityIds[0] ?? null} path={path} onVisit={onVisit} />
}
