import { useCallback, useState } from 'react'
import clsx from 'clsx'
import { brainLinkSentence, type BrainEntity, type BrainMemoryDetail } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { formatCount } from '@/lib/format'
import { brainToast, useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { openBrainSource } from '../openBrainSource'
import { MemoryQuotes } from '../MemoryQuotes'
import { EntityChip } from '../explorer/KnowledgePrimitives'

export interface MemoryActions {
  /** Walk to another person or thing the memory names. */
  onEntity: (id: string, label: string) => void
  /** Light the memory's people, things and links on the map. */
  onMap: (memory: BrainMemoryDetail) => void
  /** Open how the read that saved it was read. */
  onOpenRead: (jobId: string) => void
}

/** The open part of a row; also the whole view for a memory that names no one. */
export function MemoryOpen({
  id,
  selfId,
  actions,
  inset = false,
}: {
  id: string
  selfId: string | null
  actions: MemoryActions
  /** Indent under its row. */
  inset?: boolean
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:memory', id), [id])
  const { data, error, retry } = useBrainResource(load)
  if (!data)
    return (
      <p role="status" className={clsx('py-2 text-sm', inset && 'pl-3')}>
        {error || 'Loading memory…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  const label = (entityId: string): BrainEntity | undefined =>
    data.entities.find((entity) => entity.id === entityId)
  const others = data.memory.entityIds.filter((entityId) => entityId !== selfId)
  return (
    <div className={clsx('space-y-3 pb-3 pr-1 [overflow-wrap:anywhere]', inset && 'pl-3')}>
      <MemoryQuotes quotes={data.quotes} />
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {others.map((entityId) => (
            <EntityChip
              key={entityId}
              label={label(entityId)?.label ?? 'Unknown'}
              kind={label(entityId)?.kind}
              onClick={() => actions.onEntity(entityId, label(entityId)?.label ?? entityId)}
            />
          ))}
        </div>
      )}
      {data.memory.links.map((link) => (
        <p key={link.id} className="text-text-secondary text-sm">
          {brainLinkSentence(
            link,
            label(link.subjectId)?.label ?? 'Unknown',
            label(link.objectId)?.label ?? 'Unknown',
          )}
        </p>
      ))}
      {[...data.history.map((m) => ({ kind: 'replaced', memory: m })), ...data.related].map(
        ({ kind, memory: m }) => (
          <p key={`${kind}:${m.id}`} className="text-text-secondary text-sm">
            {kind === 'conflicts' ? 'Disagrees with' : kind === 'resolves' ? 'Answers' : 'Replaced'}
            : {m.summary}
          </p>
        ),
      )}
      {data.use.recalled > 0 && (
        <p className="text-text-tertiary text-sm">
          Lanes recalled it {formatCount(data.use.recalled, 'time')}
          {data.use.flagged ? ` · flagged ${formatCount(data.use.flagged, 'time')}` : ''}
        </p>
      )}
      <MemoryButtons data={data} actions={actions} />
    </div>
  )
}

function MemoryButtons({
  data,
  actions,
}: {
  data: BrainMemoryDetail
  actions: MemoryActions
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const [confirming, setConfirming] = useState(false)
  const forget = async (): Promise<void> => {
    setConfirming(true)
    try {
      const choice = await promptChoice({
        title: 'Forget this memory?',
        message:
          'This permanently removes the memory, its quotes and any people or things only it names. Forget cannot be undone.',
        choices: [{ value: 'forget', label: 'Forget permanently' }],
      })
      if (choice === 'forget') await useBrain.getState().forget(data.memory.id)
    } finally {
      setConfirming(false)
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      {data.sourcePath && (
        <Button
          size="xs"
          onClick={() => {
            openBrainSource(data.sourcePath!).catch((cause: unknown) =>
              brainToast(ipcErrorText(cause), 'error'),
            )
          }}
        >
          Open in lane
        </Button>
      )}
      <Button size="xs" onClick={() => actions.onMap(data)}>
        Show on map
      </Button>
      {data.memory.jobId && (
        <Button size="xs" onClick={() => actions.onOpenRead(data.memory.jobId!)}>
          How it was read
        </Button>
      )}
      <Button
        size="xs"
        className="text-danger"
        disabled={saving || confirming}
        onClick={() => {
          void forget()
        }}
      >
        Forget
      </Button>
    </div>
  )
}
