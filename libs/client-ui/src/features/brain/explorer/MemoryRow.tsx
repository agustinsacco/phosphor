import { useCallback, useState } from 'react'
import clsx from 'clsx'
import type { BrainEntity, BrainMemory, BrainMemoryDetail } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button, Tag } from '@/components/form'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { promptChoice } from '@/stores/prompt'
import { relativeTime } from '@/lib/time'
import { brainToast, useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { openBrainSource } from '../openBrainSource'
import { MemoryQuotes } from '../MemoryQuotes'
import { MEMORY_TYPE_WORDS } from '../memoryLabels'
import { EntityChip } from './KnowledgePrimitives'

/** "Nov 12", with the year only when it is not this year. */
export function saidOn(ms: number): string {
  const date = new Date(ms)
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }),
  })
}

export function MemoryTags({ memory }: { memory: BrainMemory }): React.JSX.Element {
  return (
    <div className="text-text-tertiary flex flex-wrap gap-1 text-sm">
      <Tag>{memory.type}</Tag>
      <Tag>{memory.state}</Tag>
      <Tag>{memory.kind}</Tag>
      <Tag>{memory.branch ? 'this branch' : 'project'}</Tag>
      <Tag>said {relativeTime(memory.observedAt)}</Tag>
      <Tag>recorded {relativeTime(memory.recordedAt)}</Tag>
      {memory.validTo !== null && (
        <Tag>until {new Date(memory.validTo).toISOString().slice(0, 10)}</Tag>
      )}
      {memory.validFrom !== null && (
        <Tag>since {new Date(memory.validFrom).toISOString().slice(0, 10)}</Tag>
      )}
    </div>
  )
}

export interface MemoryRowActions {
  /** Walk to another person or thing the memory names. */
  onEntity: (id: string, label: string) => void
  /** Light the memory's people and things on the map. */
  onMap: (entityIds: string[]) => void
  onOpenRead: (jobId: string) => void
  onMemory: (id: string, label: string) => void
}

/** A compact memory row; a click (or Enter) opens quotes, names and actions in place. */
export function MemoryRow({
  memory,
  selfId,
  open,
  onToggle,
  actions,
}: {
  memory: BrainMemory
  /** The profile it is listed under: its own pill is left out. */
  selfId: string | null
  open: boolean
  onToggle: () => void
  actions: MemoryRowActions
}): React.JSX.Element {
  const state =
    memory.state === 'disputed' ? 'disputed' : memory.state === 'superseded' ? 'replaced' : ''
  return (
    <li className="border-border border-b">
      <TooltipButton
        tooltip={false}
        aria-expanded={open}
        className="brain-type hover:bg-bg-secondary w-full rounded-md px-1 py-2 text-left"
        onClick={onToggle}
      >
        <span className="brain-type-label">{MEMORY_TYPE_WORDS[memory.type]}</span>
        <span className="min-w-0">
          <span className={clsx('block', !open && 'brain-clamp')}>{memory.summary}</span>
          <span className="text-text-tertiary block text-sm">
            {memory.origin?.title ?? 'Unknown lane'} · said {saidOn(memory.observedAt)}
            {state && (
              <>
                {' · '}
                <b
                  className={state === 'disputed' ? 'text-warning font-semibold' : 'font-semibold'}
                >
                  {state}
                </b>
              </>
            )}
          </span>
        </span>
      </TooltipButton>
      {open && <MemoryOpen id={memory.id} selfId={selfId} actions={actions} />}
    </li>
  )
}

/** The open part of a row; also the whole view for a memory that names no one. */
export function MemoryOpen({
  id,
  selfId,
  actions,
  inset = true,
}: {
  id: string
  selfId: string | null
  actions: MemoryRowActions
  /** Indent under the row's type column; off where it stands alone. */
  inset?: boolean
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:memory', id), [id])
  const { data, error, retry } = useBrainResource(load)
  if (!data)
    return (
      <p role="status" className={clsx('py-2 text-sm', inset && 'pl-[6.1rem]')}>
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
    <div className={clsx('space-y-3 pb-3 pr-1 [overflow-wrap:anywhere]', inset && 'pl-[6.1rem]')}>
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
          {label(link.subjectId)?.label} → {link.predicate.replaceAll('_', ' ')} →{' '}
          {label(link.objectId)?.label}
        </p>
      ))}
      {[...data.history.map((m) => ({ kind: 'replaced', memory: m })), ...data.related].map(
        ({ kind, memory: m }) => (
          <TooltipButton
            key={`${kind}:${m.id}`}
            className="text-text-secondary block text-left text-sm hover:underline"
            onClick={() => actions.onMemory(m.id, m.summary)}
          >
            {kind === 'conflicts' ? 'Disagrees with' : kind === 'resolves' ? 'Answers' : 'Replaced'}
            : {m.summary}
          </TooltipButton>
        ),
      )}
      <MemoryButtons data={data} actions={actions} />
      <details className="text-sm">
        <TooltipSummary className="text-text-tertiary cursor-pointer">
          Dates and scope
        </TooltipSummary>
        <MemoryTags memory={data.memory} />
      </details>
    </div>
  )
}

function MemoryButtons({
  data,
  actions,
}: {
  data: BrainMemoryDetail
  actions: MemoryRowActions
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
      <Button size="xs" onClick={() => actions.onMap(data.memory.entityIds)}>
        Show on map
      </Button>
      {data.memory.jobId && (
        <Button size="xs" onClick={() => actions.onOpenRead(data.memory.jobId!)}>
          See the read
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
