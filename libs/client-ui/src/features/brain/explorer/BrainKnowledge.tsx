import { BrainSearch } from './BrainSearch'
import { BrainTrail } from './BrainTrail'
import { BrainEntity } from './BrainEntity'
import { BrainBrowse } from './BrainBrowse'
import { BrainMemoryDetail } from '../BrainMemory'
import { ExplorerGraph } from './ExplorerGraph'
import type { ExplorerState } from './useExplorer'
import './knowledge.css'

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
    <div className="brain-knowledge">
      <div aria-label="Brain Explorer" className="brain-knowledge-column">
        <BrainSearch shortcut onSelect={onVisit} onQuery={state.setQuery} />
        <BrainTrail trail={state.trail} onMove={state.move} onJump={state.jump} />
        {visit?.kind === 'entity' ? (
          <BrainEntity key={visit.id} id={visit.id} onVisit={onVisit} onPath={state.setPath} />
        ) : visit?.kind === 'memory' ? (
          <BrainMemoryDetail
            key={visit.id}
            id={visit.id}
            onFocus={(id, label) => onVisit({ kind: 'entity', id, label })}
            onMemory={(id, label) => onVisit({ kind: 'memory', id, label })}
            onForget={() => state.jump(-1)}
            onExtraction={onOpenRead}
          />
        ) : (
          <BrainBrowse onVisit={onVisit} />
        )}
      </div>
      <ExplorerGraph
        entityId={visit?.kind === 'entity' ? visit.id : null}
        memoryId={visit?.kind === 'memory' ? visit.id : null}
        label={visit?.label}
        path={state.path}
        onVisit={onVisit}
        onClear={() => state.jump(-1)}
      />
    </div>
  )
}
