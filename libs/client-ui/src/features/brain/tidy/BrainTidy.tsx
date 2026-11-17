import { useCallback, useEffect, useRef, useState } from 'react'
import { ListDetail } from '@/components/ListDetail'
import { Button } from '@/components/form'
import { relativeTime } from '@/lib/time'
import type { BrainVisit } from '../explorer/trail'
import { useBrainResource } from '../useBrainResource'
import { useBrain } from '../useBrain'
import { useTidyPage } from './useTidyPage'
import { useTidyActions } from './useTidyActions'
import { useTidyDetail } from './useTidyDetail'
import type { BrainTidyPage } from '@shared/brain-tidy'
import { TidyHeader } from './TidyHeader'
import { TidyList, type TidySelection } from './TidyList'
import { TidyDetail } from './TidyDetail'

export function BrainTidy({
  active,
  onVisit,
  recent = 0,
}: {
  active: boolean
  onVisit: (visit: BrainVisit) => void
  recent?: number
}): React.JSX.Element {
  const state = useTidyView(active, recent)
  const { page, selected, setSelected, actions } = state
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TidyHeader
        active={active}
        page={page}
        busy={actions.busy}
        onRun={() => actions.run()}
        onCancel={() => actions.run(true)}
      />
      {(actions.message || state.settled) && (
        <p role="status" className="p-3 [overflow-wrap:anywhere]">
          {actions.message || state.settled}
        </p>
      )}
      <ListDetail
        listLabel="Brain Tidy"
        detailLabel="Tidy detail"
        open={!!selected}
        onBack={() => setSelected(null)}
        backLabel="Tidy"
        list={<TidyListPane state={state} />}
        detail={(back) => <TidyDetailPane state={state} onVisit={onVisit} back={back} />}
      />
    </div>
  )
}

function useTidyView(active: boolean, recent: number) {
  const [selected, setSelected] = useState<TidySelection>(null)
  const { page, error, loading, reload } = useTidyPage(active)
  const id = selected?.type === 'suggestion' ? selected.id : ''
  const detail = useTidyDetail(id)
  const summary = useBrain((s) => JSON.stringify(s.status?.tidy))
  const changes = useBrainResource(
    useCallback(() => window.phosphor.invoke('brain:tidyChanges', 100), []),
    active,
    summary,
  )
  const [previousChanges, setPreviousChanges] = useState(changes.data)
  useEffect(() => {
    if (changes.data) setPreviousChanges(changes.data)
  }, [changes.data])
  const operations = changes.data?.items ?? previousChanges?.items ?? []
  useEffect(() => {
    // Absence from a bounded page does not mean the selected record was removed.
    if (page?.items[0] && !selected) setSelected({ type: 'suggestion', id: page.items[0].id })
  }, [page, selected])
  const openedRecent = useRef(0)
  useEffect(() => {
    if (recent !== openedRecent.current && changes.data?.items[0]) {
      openedRecent.current = recent
      setSelected({ type: 'operation', id: changes.data.items[0].id })
    }
  }, [recent, changes.data])
  const selectNext = useCallback(
    (fresh: BrainTidyPage | null = page): void => {
      const index = page?.items.findIndex((s) => s.id === selected?.id) ?? -1
      const nextId = page?.items[index + 1]?.id
      const next =
        fresh?.items.find((s) => s.id === nextId) ?? fresh?.items.find((s) => s.id !== selected?.id)
      setSelected(next ? { type: 'suggestion', id: next.id } : null)
    },
    [page, selected],
  )
  const settled = useSettledSuggestion(id, detail, reload, selectNext)
  const actions = useTidyActions({
    detail: detail.data,
    page,
    reload,
    reloadDetail: detail.reload,
    retryChanges: changes.retry,
    selected,
    selectNext,
  })
  const operation = operations.find((op) => selected?.type === 'operation' && op.id === selected.id)
  return {
    page,
    error,
    loading,
    reload,
    changes,
    detail,
    id,
    operations,
    selected,
    setSelected,
    actions,
    operation,
    settled,
  }
}
type TidyView = ReturnType<typeof useTidyView>
function TidyListPane({ state }: { state: TidyView }): React.JSX.Element {
  const { page, error, reload, changes, operations, selected, setSelected, loading, actions } =
    state
  return (
    <>
      {error && (
        <p role="status" className="p-3">
          {error}{' '}
          <Button
            onClick={() => {
              void reload()
            }}
          >
            Retry
          </Button>
        </p>
      )}
      {changes.error && (
        <p role="status" className="p-3">
          {changes.error} <Button onClick={changes.retry}>Retry recent changes</Button>
        </p>
      )}
      {page && !page.items.length && (
        <div className="space-y-2 p-3">
          <p>Nothing to tidy.</p>
          <p className="text-text-secondary text-sm">
            Tidy looks for repeated names, repeated memories and disagreements.
          </p>
        </div>
      )}
      <TidyList
        page={page}
        changes={operations}
        selected={selected}
        onSelect={setSelected}
        onMore={() => {
          void reload(true)
        }}
        loading={loading}
        busy={actions.busy}
        onUndo={actions.undo}
      />
    </>
  )
}
function TidyDetailPane({
  state,
  onVisit,
  back,
}: {
  state: TidyView
  onVisit: (visit: BrainVisit) => void
  back: React.ReactNode
}): React.JSX.Element {
  const { id, detail, actions, operation } = state
  return (
    <div className="h-full min-w-0 overflow-y-auto [overflow-wrap:anywhere]">
      {back}
      {id &&
        (detail.data?.suggestion.state === 'open' ? (
          <TidyDetail
            key={`${id}:${detail.data.revision}`}
            data={detail.data}
            busy={actions.busy}
            onApply={actions.apply}
            onDismiss={actions.dismiss}
            onVisit={onVisit}
          />
        ) : (
          <p role="status" className="p-3">
            {detail.error || 'Loading suggestion…'}
            {detail.error && <Button onClick={detail.retry}>Retry</Button>}
          </p>
        ))}
      {operation && (
        <article className="space-y-3 p-3">
          <h2>{operation.summary}</h2>
          <p>
            {operation.automatic ? 'Automatic' : 'By you'} · {relativeTime(operation.createdAt)}
          </p>
          <p>
            {operation.kind === 'fold'
              ? 'Combined repeated memories and their evidence.'
              : operation.kind === 'merge'
                ? 'Combined names, links and memories.'
                : operation.kind === 'replace'
                  ? 'One memory replaced the other.'
                  : 'Kept both memories as disputed.'}
          </p>
          {operation.undoneAt ? (
            <p>Undone {relativeTime(operation.undoneAt)}</p>
          ) : (
            <Button disabled={actions.busy} onClick={() => actions.undo(operation.id)}>
              Undo
            </Button>
          )}
        </article>
      )}
    </div>
  )
}

function useSettledSuggestion(
  id: string,
  detail: ReturnType<typeof useTidyDetail>,
  reload: () => Promise<BrainTidyPage | null>,
  selectNext: (page: BrainTidyPage | null) => void,
): string {
  const [message, setMessage] = useState('')
  useEffect(() => {
    if (!id || !detail.loaded || detail.data?.suggestion.state === 'open') return
    let alive = true
    setMessage('This suggestion was already settled.')
    void reload().then((page) => {
      if (alive && page) selectNext(page)
    })
    return () => {
      alive = false
    }
  }, [id, detail.loaded, detail.data, reload, selectNext])
  return message
}
