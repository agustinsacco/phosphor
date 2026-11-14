import { useCallback } from 'react'
import type { BrainLink } from '@shared/brain'
import { PageShell } from '@/components/PageShell'
import { ListDetail } from '@/components/ListDetail'
import { Button } from '@/components/form'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { useBrain, useBrainSync } from './useBrain'
import { BrainInbox } from './BrainInbox'
import { BrainExtraction } from './BrainExtraction'
import { BrainReview } from './BrainReview'
import { BrainMemoryDetail } from './BrainMemory'
import { useBrainResource } from './useBrainResource'
import { BrainSearch } from './explorer/BrainSearch'
import { BrainEntity } from './explorer/BrainEntity'
import { BrainTrail } from './explorer/BrainTrail'
import { ExplorerGraph } from './explorer/ExplorerGraph'
import type { BrainVisit } from './explorer/trail'
import { useExplorer, type ExplorerState } from './explorer/useExplorer'
import { formatCount } from '@/lib/format'

export function BrainPage(): React.JSX.Element {
  useBrainSync()
  const supported = usePlatform().localBrain
  const status = useBrain((s) => s.status)
  const error = useBrain((s) => s.error)
  const openSettings = useOpenSettings()
  return (
    <PageShell
      wide
      title={
        <span>
          Brain{' '}
          {status && (
            <span className="text-text-tertiary ml-3 text-sm font-normal">
              {formatCount(status.counts.memories, 'memory', 'memories')} ·{' '}
              {formatCount(status.counts.entities, 'thing')}
            </span>
          )}
        </span>
      }
      actions={
        supported && (
          <Button size="sm" onClick={() => openSettings('local', 'brain')}>
            Settings
          </Button>
        )
      }
    >
      {!supported ? (
        <p className="p-8">Brain is available on Desktop</p>
      ) : !status ? (
        <div role="status" className="p-8">
          {error || 'Loading Brain…'}
          <Button
            onClick={() => {
              void useBrain.getState().refresh()
            }}
          >
            Retry
          </Button>
        </div>
      ) : (
        <BrainContent key={status.generation} />
      )}
    </PageShell>
  )
}

function BrainContent(): React.JSX.Element {
  const state = useExplorer()
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BrainTrail trail={state.trail} onMove={state.move} onJump={state.jump} />
      <ListDetail
        listLabel="Brain Explorer"
        detailLabel="Brain graph and review"
        open={!!state.review || !!state.extraction}
        onBack={() => {
          if (state.extraction) state.setExtraction(null)
          else state.setReview(null)
        }}
        backLabel="Explorer"
        list={<ExplorerDetails state={state} />}
        detail={(back) => (
          <div className="flex h-full min-h-0 flex-col">
            {back}
            <ExplorerPanel state={state} />
          </div>
        )}
      />
    </div>
  )
}
function ExplorerDetails({ state }: { state: ExplorerState }): React.JSX.Element {
  const jobs = useBrain((s) => s.status?.jobs ?? [])
  const { visit, onVisit, setExtraction } = state
  return (
    <>
      <div className="p-3">
        <BrainSearch shortcut onSelect={onVisit} onQuery={state.setQuery} />
      </div>
      <BrainInbox
        jobs={jobs}
        onReview={(id) => {
          state.setReview(id)
          setExtraction(null)
        }}
        onExtraction={setExtraction}
      />
      {visit?.kind === 'entity' ? (
        <BrainEntity key={visit.id} id={visit.id} onVisit={onVisit} onPath={state.setPath} />
      ) : visit?.kind === 'memory' ? (
        <BrainMemoryDetail
          key={visit.id}
          id={visit.id}
          onFocus={(id, label) => onVisit({ kind: 'entity', id, label })}
          onMemory={(id, label) => onVisit({ kind: 'memory', id, label })}
          onForget={() => state.move(-1)}
          onExtraction={setExtraction}
        />
      ) : (
        <p className="text-text-tertiary p-3 text-sm">
          Find a person, project or memory, or choose a node in the overview. Follow connections to
          explore what Brain knows.
        </p>
      )}
    </>
  )
}
function ExplorerPanel({ state }: { state: ExplorerState }): React.JSX.Element {
  const { extraction, review, visit, path, onVisit, setExtraction } = state
  if (extraction)
    return (
      <div className="overflow-auto">
        <BrainExtraction
          jobId={extraction}
          onBack={() => setExtraction(null)}
          onMemory={(id) => onVisit({ kind: 'memory', id, label: 'Memory' })}
        />
      </div>
    )
  if (review)
    return (
      <div className="overflow-auto">
        <BrainReview
          jobId={review}
          onClose={() => state.setReview(null)}
          onExtraction={setExtraction}
        />
      </div>
    )
  return visit?.kind === 'memory' ? (
    <MemoryGraph id={visit.id} path={path} onVisit={onVisit} />
  ) : (
    <ExplorerGraph entityId={visit?.id ?? null} path={path} onVisit={onVisit} />
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
