import { useRef, useState } from 'react'
import clsx from 'clsx'
import { Button } from '@/components/form'
import { useBoxSize } from '../useBoxSize'
import { pageKeyTarget } from '../pageKeys'
import { KnowledgeIndex } from './KnowledgeIndex'
import { KnowledgeProfile, MemoryVisit } from './KnowledgeProfile'
import { KnowledgeStart } from './KnowledgeStart'
import { BrainMap, type MapHighlight } from './BrainMap'
import { FullMap } from './FullMap'
import { ProfileTrail } from './ProfileHeader'
import type { MemoryRowActions } from './MemoryRow'
import type { ExplorerState } from './useExplorer'

/** Page widths at or below this give the map a profile tab instead of its own column. */
const MAP_COLUMN_MIN = 1060
const WIDE = { width: Infinity, height: 0 }

export function BrainKnowledge({
  state,
  searchRequest,
  onOpenRead,
}: {
  state: ExplorerState
  /** Bumped by `/` and the header's search button: focus the index search. */
  searchRequest: number
  /** Show the read that produced a memory: the Lanes tab opens on that job. */
  onOpenRead: (jobId: string) => void
}): React.JSX.Element {
  const { visit, onVisit } = state
  const root = useRef<HTMLDivElement>(null)
  const narrow = useBoxSize(root, WIDE).width <= MAP_COLUMN_MIN
  const [full, setFull] = useState(false)
  const [hops, setHops] = useState<1 | 2>(1)
  const [highlight, setHighlight] = useState<MapHighlight>({ hover: null, lit: null })
  const [connectionsRequest, setConnectionsRequest] = useState(0)
  const entity = visit?.kind === 'entity' ? visit : null
  const visitEntity = (id: string, label: string): void => {
    setHighlight({ hover: null, lit: null })
    onVisit({ kind: 'entity', id, label })
  }
  const map = entity && (
    <BrainMap
      key={entity.id}
      entityId={entity.id}
      label={entity.label}
      hops={hops}
      onHops={setHops}
      highlight={highlight}
      onHover={(hover) => setHighlight((old) => ({ ...old, hover }))}
      onVisit={visitEntity}
      onMore={() => setConnectionsRequest((n) => n + 1)}
      onFull={() => setFull(true)}
    />
  )
  const actions: MemoryRowActions = {
    onEntity: visitEntity,
    onMap: (lit) => setHighlight({ hover: null, lit }),
    onOpenRead,
    onMemory: (id, label) => onVisit({ kind: 'memory', id, label }),
  }
  const move = (delta: number): void => {
    setHighlight({ hover: null, lit: null })
    state.move(delta)
  }
  const jump = (index: number): void => {
    setHighlight({ hover: null, lit: null })
    state.jump(index)
  }
  const trail = <ProfileTrail trail={state.trail} onMove={move} onJump={jump} />
  const onKeyDown = (event: React.KeyboardEvent): void => {
    for (const [key, delta] of [
      ['[', -1],
      [']', 1],
    ] as const)
      if (pageKeyTarget(event, key)) {
        event.preventDefault()
        move(delta)
      }
  }
  return (
    <div
      ref={root}
      className={clsx('brain-panes brain-knowledge', (narrow || full) && 'brain-knowledge--narrow')}
      onKeyDown={onKeyDown}
    >
      <section aria-label="Index" className="brain-pane brain-pane--side brain-pane--start">
        <KnowledgeIndex
          selectedId={entity?.id ?? null}
          searchRequest={searchRequest}
          onVisit={(next) => {
            setFull(false)
            setHighlight({ hover: null, lit: null })
            onVisit(next)
          }}
        />
      </section>
      {full ? (
        <section aria-label="Profile" className="brain-pane">
          <FullMap
            entityId={entity?.id ?? null}
            label={entity?.label}
            path={state.path}
            onOpen={(next) => {
              setFull(false)
              onVisit(next)
            }}
            onClose={() => setFull(false)}
          />
        </section>
      ) : (
        <>
          <section aria-label="Profile" className="brain-pane">
            {entity ? (
              <KnowledgeProfile
                visit={entity}
                trail={trail}
                map={narrow ? map : null}
                connectionsRequest={connectionsRequest}
                onVisit={(next) => {
                  setHighlight({ hover: null, lit: null })
                  onVisit(next)
                }}
                onPath={state.setPath}
                onHover={(hover) => setHighlight((old) => ({ ...old, hover }))}
                onLit={(lit) => setHighlight({ hover: null, lit })}
                onOpenRead={onOpenRead}
                onFullMap={() => setFull(true)}
              />
            ) : visit?.kind === 'memory' ? (
              <MemoryVisit
                key={visit.id}
                visit={visit}
                onReplace={state.replace}
                actions={actions}
              />
            ) : (
              <KnowledgeStart trail={state.trail.items.length ? trail : null} onVisit={onVisit} />
            )}
          </section>
          {!narrow && (
            <aside aria-label="Map" className="brain-pane brain-pane--end">
              {map ?? (
                <div className="space-y-2 p-4 text-sm">
                  <p className="text-text-tertiary">
                    The map follows what you select: the person or thing in the middle, its
                    neighbours around it.
                  </p>
                  <Button size="xs" onClick={() => setFull(true)}>
                    Full map
                  </Button>
                </div>
              )}
            </aside>
          )}
        </>
      )}
    </div>
  )
}
