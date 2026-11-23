import { useCallback, useEffect, useState } from 'react'
import type { BrainEntityView, BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { EntityEditDialog, profileMenu, type EntityEdit } from './EntityEdits'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { useEntityView } from './useEntityView'
import { ProfileToolPanel } from './EntityActions'
import { ProfileHeader, type ProfileTab, type ProfileTool } from './ProfileHeader'
import { NO_MEMORY_FILTERS, ProfileMemories, type MemoryFilters } from './ProfileMemories'
import { ProfileConnections } from './ProfileConnections'
import { ProfileLanes } from './ProfileLanes'
import { MemoryOpen, type MemoryRowActions } from './MemoryRow'
import type { BrainVisit } from './trail'

export interface ProfileProps {
  visit: Extract<BrainVisit, { kind: 'entity' }>
  /** Back, forward and the last steps; drawn in the header. */
  trail: React.ReactNode
  /** The map, when the page is too narrow for its own column. */
  map: React.ReactNode | null
  /** A request from the map's "+N more": show Connections. */
  connectionsRequest: number
  onVisit: (visit: BrainVisit) => void
  onReplace: (visit: BrainVisit) => void
  onPath: (path: BrainLink[] | null) => void
  onHover: (id: string | null) => void
  onLit: (ids: string[] | null) => void
  onOpenRead: (jobId: string) => void
  onFullMap: () => void
}

/** The middle pane of Knowledge: a profile that reads like a page, with its own tabs. */
export function KnowledgeProfile(props: ProfileProps): React.JSX.Element {
  const { visit, onReplace } = props
  const { data, error, retry } = useEntityView(visit.id)
  useEffect(() => {
    if (data && data.entity.id !== visit.id)
      onReplace({ ...visit, id: data.entity.id, label: data.entity.label })
  }, [data, visit, onReplace])
  if (!data)
    return (
      <div className="space-y-2 px-4 pt-2">
        {props.trail}
        <p role="status">
          {error || 'Loading…'}{' '}
          {error && (
            <Button size="xs" onClick={retry}>
              Retry
            </Button>
          )}
        </p>
      </div>
    )
  return <Profile key={visit.id} view={data} {...props} />
}

function Profile({
  view,
  visit,
  trail,
  map,
  connectionsRequest,
  onVisit,
  onPath,
  onHover,
  onLit,
  onOpenRead,
  onFullMap,
}: ProfileProps & { view: BrainEntityView }): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const state = useProfileState(visit.memoryId, connectionsRequest)
  const { tab, setTab, tool, setTool } = state
  // The Map tab only exists while the map has no column of its own.
  const shown: ProfileTab = tab === 'map' && !map ? 'memories' : tab
  const actions: MemoryRowActions = {
    onEntity: (id, label) => onVisit({ kind: 'entity', id, label }),
    onMap: (ids) => {
      onLit(ids)
      if (map) setTab('map')
    },
    onOpenRead,
    onMemory: (id, label) => onVisit({ kind: 'memory', id, label }),
  }
  return (
    <article aria-label={view.entity.label} className="flex min-h-0 flex-1 flex-col">
      <ProfileHeader
        trail={trail}
        view={view}
        tab={shown}
        tabs={profileTabs(view, !!map)}
        onTab={setTab}
        tool={tool}
        onTool={(next) => {
          onPath(null)
          setTool(next)
        }}
        menu={profileMenu(view, state.setEdit, onFullMap)}
        saving={saving}
      />
      <div
        id={`brain-profile-panel-${shown}`}
        role="tabpanel"
        aria-labelledby={`brain-profile-tab-${shown}`}
        className={shown === 'map' ? 'flex min-h-0 flex-1 flex-col' : 'brain-scroll px-4'}
      >
        {shown === 'map' ? (
          map
        ) : (
          <ProfileBody
            view={view}
            tab={shown}
            state={state}
            actions={actions}
            onVisit={onVisit}
            onHover={onHover}
            onPath={(path) => {
              onPath(path)
              if (path) onFullMap()
            }}
          />
        )}
      </div>
      {state.edit && (
        <EntityEditDialog edit={state.edit} view={view} onClose={() => state.setEdit(null)} />
      )}
    </article>
  )
}

function profileTabs(view: BrainEntityView, map: boolean): { value: ProfileTab; label: string }[] {
  const memories = Object.values(view.memoryCounts).reduce((sum, n) => sum + n, 0)
  const neighbours = view.groups.reduce((sum, group) => sum + group.total, 0)
  return [
    { value: 'memories', label: `Memories ${memories}` },
    { value: 'connections', label: `Connections ${neighbours}` },
    { value: 'lanes', label: `Lanes ${view.sources.length}` },
    ...(map ? [{ value: 'map' as const, label: 'Map' }] : []),
  ]
}

/** Tab, memory filters, the open memory, the route or merge tool and an open edit dialog. */
function useProfileState(memoryId: string | undefined, connectionsRequest: number) {
  const [tab, setTab] = useState<ProfileTab>('memories')
  const [filters, setFilters] = useState<MemoryFilters>(NO_MEMORY_FILTERS)
  const [openId, setOpenId] = useState<string | null>(memoryId ?? null)
  const [tool, setTool] = useState<ProfileTool | null>(null)
  const [edit, setEdit] = useState<EntityEdit | null>(null)
  useEffect(() => {
    if (!memoryId) return
    setOpenId(memoryId)
    setFilters(NO_MEMORY_FILTERS)
    setTab('memories')
  }, [memoryId])
  useEffect(() => {
    if (connectionsRequest) setTab('connections')
  }, [connectionsRequest])
  return { tab, setTab, filters, setFilters, openId, setOpenId, tool, setTool, edit, setEdit }
}

function ProfileBody({
  view,
  tab,
  state,
  actions,
  onVisit,
  onHover,
  onPath,
}: {
  view: BrainEntityView
  tab: ProfileTab
  state: ReturnType<typeof useProfileState>
  actions: MemoryRowActions
  onVisit: (visit: BrainVisit) => void
  onHover: (id: string | null) => void
  onPath: (path: BrainLink[] | null) => void
}): React.JSX.Element {
  const { tool, setTool, filters, setFilters, openId, setOpenId, setTab } = state
  return (
    <>
      {tool && (
        <div className="pt-3">
          <ProfileToolPanel
            entity={view.entity}
            tool={tool}
            onClose={() => setTool(null)}
            onVisit={onVisit}
            onPath={onPath}
          />
        </div>
      )}
      <About view={view} />
      {tab === 'memories' && (
        <ProfileMemories
          view={view}
          openId={openId}
          onOpen={setOpenId}
          filters={filters}
          onFilters={setFilters}
          actions={actions}
        />
      )}
      {tab === 'connections' && (
        <ProfileConnections view={view} onEntity={actions.onEntity} onHover={onHover} />
      )}
      {tab === 'lanes' && (
        <ProfileLanes
          view={view}
          onLane={(lane) => {
            setFilters({ ...NO_MEMORY_FILTERS, lane })
            setTab('memories')
          }}
        />
      )}
    </>
  )
}

/** The description, then every other name in one line; merged ones say so in place. */
function About({ view }: { view: BrainEntityView }): React.JSX.Element {
  const { entity, merged } = view
  const names = [
    ...entity.aliases.map((name) => ({ name, merged: merged.includes(name) })),
    ...merged
      .filter((name) => !entity.aliases.includes(name))
      .map((name) => ({ name, merged: true })),
  ]
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 py-3 text-sm">
      <dt className="brain-type-label">About</dt>
      <dd className={entity.description ? '' : 'text-text-tertiary'}>
        {entity.description || 'No description yet.'}
      </dd>
      {names.length > 0 && (
        <>
          <dt className="brain-type-label">Also called</dt>
          <dd className="flex flex-wrap gap-1">
            {names.map(({ name, merged: wasMerged }) => (
              <span key={name} className="bg-chip rounded-md px-1.5 py-0.5">
                {name}
                {wasMerged && <i className="text-text-tertiary ml-1 text-xs not-italic">merged</i>}
              </span>
            ))}
          </dd>
        </>
      )}
    </dl>
  )
}

/** A memory visit opens the profile of the first person or thing it names, with it open. */
export function MemoryVisit({
  visit,
  onReplace,
  actions,
}: {
  visit: Extract<BrainVisit, { kind: 'memory' }>
  onReplace: (visit: BrainVisit) => void
  actions: MemoryRowActions
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:memory', visit.id), [visit.id])
  const { data, error, retry } = useBrainResource(load)
  const first = data?.memory.entityIds[0]
  const entity = data?.entities.find((e) => e.id === first)
  useEffect(() => {
    if (entity)
      onReplace({ kind: 'entity', id: entity.id, label: entity.label, memoryId: visit.id })
  }, [entity, onReplace, visit.id])
  if (!data || entity)
    return (
      <p role="status" className="p-4">
        {error || 'Loading memory…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  return (
    <article aria-label="Memory" className="brain-scroll p-4">
      <h2 className="pb-1 text-lg font-semibold">{data.memory.summary}</h2>
      <p className="text-text-tertiary pb-3 text-sm">It names no person or thing.</p>
      <MemoryOpen id={visit.id} selfId={null} actions={actions} inset={false} />
    </article>
  )
}
