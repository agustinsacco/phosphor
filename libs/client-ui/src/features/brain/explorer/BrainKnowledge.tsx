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
import type { BrainVisit } from './trail'
import type { ExplorerState } from './useExplorer'

/** Page widths at or below this give the map a profile tab instead of its own column. */
const MAP_COLUMN_MIN = 1060
const WIDE = { width: Infinity, height: 0 }
const NO_HIGHLIGHT: MapHighlight = { hover: null, lit: null }

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
  const root = useRef<HTMLDivElement>(null)
  const narrow = useBoxSize(root, WIDE).width <= MAP_COLUMN_MIN
  const view = useKnowledgeView(state, onOpenRead)
  const { entity, full, setFull } = view
  const map = entity && (
    <BrainMap
      key={entity.id}
      entityId={entity.id}
      label={entity.label}
      hops={view.hops}
      onHops={view.setHops}
      highlight={view.highlight}
      onHover={view.hover}
      onVisit={view.actions.onEntity}
      onMore={view.showConnections}
      onFull={() => setFull(true)}
    />
  )
  const trail = <ProfileTrail trail={state.trail} onMove={view.move} onJump={view.jump} />
  return (
    <div
      ref={root}
      className={clsx('brain-panes brain-knowledge', (narrow || full) && 'brain-knowledge--narrow')}
      onKeyDown={view.onKeyDown}
    >
      <section aria-label="Index" className="brain-pane brain-pane--side brain-pane--start">
        <KnowledgeIndex
          selectedId={entity?.id ?? null}
          searchRequest={searchRequest}
          onVisit={view.visitFromIndex}
        />
      </section>
      {full ? (
        <section aria-label="Profile" className="brain-pane">
          <FullMap
            entityId={entity?.id ?? null}
            label={entity?.label}
            path={state.path}
            onOpen={view.visitFromIndex}
            onClose={() => setFull(false)}
          />
        </section>
      ) : (
        <>
          <section aria-label="Profile" className="brain-pane">
            <ProfilePane
              state={state}
              view={view}
              trail={trail}
              map={narrow ? map : null}
              narrow={narrow}
              onOpenRead={onOpenRead}
            />
          </section>
          {!narrow && (
            <aside aria-label="Map" className="brain-pane brain-pane--end">
              {map ?? <MapPlaceholder onFull={() => setFull(true)} />}
            </aside>
          )}
        </>
      )}
    </div>
  )
}

/** The profile, a memory being resolved to its profile, or the start page. */
function ProfilePane({
  state,
  view,
  trail,
  map,
  narrow,
  onOpenRead,
}: {
  state: ExplorerState
  view: KnowledgeView
  trail: React.ReactNode
  map: React.ReactNode | null
  /** No map column: the start page offers the full map itself. */
  narrow: boolean
  onOpenRead: (jobId: string) => void
}): React.JSX.Element {
  const { current, entity } = view
  if (entity)
    return (
      <KnowledgeProfile
        key={entity.id}
        visit={entity}
        onReplace={state.replace}
        trail={trail}
        map={map}
        connectionsRequest={view.connectionsRequest}
        onVisit={view.visit}
        onPath={state.setPath}
        onHover={view.hover}
        onLit={view.light}
        onOpenRead={onOpenRead}
        onFullMap={() => view.setFull(true)}
      />
    )
  if (current?.kind === 'memory')
    return (
      <MemoryVisit
        key={current.id}
        visit={current}
        onReplace={state.replace}
        actions={view.actions}
      />
    )
  return (
    <KnowledgeStart
      trail={state.trail.items.length ? trail : null}
      onVisit={state.onVisit}
      onFullMap={narrow ? () => view.setFull(true) : null}
    />
  )
}

type KnowledgeView = ReturnType<typeof useKnowledgeView>

/** What the map, the trail keys and every walk share: a walk clears what the map lit. */
function useKnowledgeView(state: ExplorerState, onOpenRead: (jobId: string) => void) {
  const [full, setFull] = useState(false)
  const [hops, setHops] = useState<1 | 2>(1)
  const [highlight, setHighlight] = useState<MapHighlight>(NO_HIGHLIGHT)
  const [connectionsRequest, setConnectionsRequest] = useState(0)
  const visit = (next: BrainVisit): void => {
    setHighlight(NO_HIGHLIGHT)
    state.onVisit(next)
  }
  const move = (delta: number): void => {
    setHighlight(NO_HIGHLIGHT)
    state.move(delta)
  }
  const actions: MemoryRowActions = {
    onEntity: (id, label) => visit({ kind: 'entity', id, label }),
    onMap: (lit) => setHighlight({ hover: null, lit }),
    onOpenRead,
    onMemory: (id, label) => visit({ kind: 'memory', id, label }),
  }
  return {
    visit,
    current: state.visit,
    entity: state.visit?.kind === 'entity' ? state.visit : null,
    full,
    setFull,
    hops,
    setHops,
    highlight,
    connectionsRequest,
    actions,
    move,
    jump: (index: number): void => {
      setHighlight(NO_HIGHLIGHT)
      state.jump(index)
    },
    hover: (hover: string | null): void => setHighlight((old) => ({ ...old, hover })),
    light: (lit: string[] | null): void => setHighlight({ hover: null, lit }),
    showConnections: (): void => setConnectionsRequest((n) => n + 1),
    visitFromIndex: (next: BrainVisit): void => {
      setFull(false)
      visit(next)
    },
    onKeyDown: (event: React.KeyboardEvent): void => {
      for (const [key, delta] of [
        ['[', -1],
        [']', 1],
      ] as const)
        if (pageKeyTarget(event, key)) {
          event.preventDefault()
          move(delta)
        }
    },
  }
}

function MapPlaceholder({ onFull }: { onFull: () => void }): React.JSX.Element {
  return (
    <div className="space-y-2 p-4 text-sm">
      <p className="text-text-tertiary">
        The map follows what you select: the person or thing in the middle, its neighbours around
        it.
      </p>
      <Button size="xs" onClick={onFull}>
        Full map
      </Button>
    </div>
  )
}
