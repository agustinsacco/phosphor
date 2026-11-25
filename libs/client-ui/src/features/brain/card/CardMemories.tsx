import { useCallback, useState } from 'react'
import clsx from 'clsx'
import type { BrainMemory } from '@shared/brain'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { MemoryOpen, type MemoryActions } from './MemoryOpen'
import { memoryWords } from './memoryWords'

/** The card's memories, newest first, each with what kind it is and who said it, in words. */
interface CardMemoryProps {
  entityId: string
  count: number
  actions: MemoryActions
}
export function CardMemories(props: CardMemoryProps): React.JSX.Element {
  const revision = useBrain((s) => s.status?.revision ?? 0)
  // Earlier pages and the expanded row both belong to this revision.
  return <MemoryList key={revision} {...props} />
}
function MemoryList({ entityId, count, actions }: CardMemoryProps): React.JSX.Element {
  const { data, error, retry, memories, more } = useMemoryPages(entityId)
  const [openId, setOpenId] = useState<string | null>(null)
  const now = Date.now()
  return (
    <section aria-label="Memories" className="space-y-1">
      <SectionLabel>Memories · {count}</SectionLabel>
      <ul className="divide-border divide-y">
        {memories.map((memory) => (
          <MemoryLine
            key={memory.id}
            memory={memory}
            words={memoryWords(memory, now)}
            open={memory.id === openId}
            onToggle={() => setOpenId(memory.id === openId ? null : memory.id)}
            entityId={entityId}
            actions={actions}
          />
        ))}
      </ul>
      {!data && (
        <p role="status" className="text-sm">
          {error || 'Loading memories…'}{' '}
          {error && (
            <Button size="xs" onClick={retry}>
              Retry
            </Button>
          )}
        </p>
      )}
      {data && !memories.length && <p className="text-text-tertiary text-sm">No memories yet.</p>}
      {data?.next && (
        <Button size="xs" onClick={more}>
          Show more memories
        </Button>
      )}
    </section>
  )
}

function MemoryLine({
  memory,
  words,
  open,
  onToggle,
  entityId,
  actions,
}: {
  memory: BrainMemory
  words: string
  open: boolean
  onToggle: () => void
  entityId: string
  actions: MemoryActions
}): React.JSX.Element {
  return (
    <li>
      <TooltipButton
        tooltip={false}
        aria-expanded={open}
        className="hover:bg-bg-secondary block w-full rounded-md px-1 py-1.5 text-left"
        onClick={onToggle}
      >
        <span className={clsx('block', !open && 'brain-clamp')}>{memory.summary}</span>
        <span className="text-text-tertiary block text-xs">{words}</span>
      </TooltipButton>
      {open && <MemoryOpen id={memory.id} selfId={entityId} actions={actions} inset />}
    </li>
  )
}

/** Current memories, newest first; a new page appends without repeats. */
function useMemoryPages(id: string) {
  const [cursor, setCursor] = useState<string | null>(null)
  const load = useCallback(
    () => window.phosphor.invoke('brain:entityMemories', id, {}, cursor),
    [id, cursor],
  )
  const { data, error, retry } = useBrainResource(load)
  const [previous, setPrevious] = useState<BrainMemory[]>([])
  const memories = [
    ...new Map([...previous, ...(data?.memories ?? [])].map((m) => [m.id, m])).values(),
  ]
  return {
    data,
    error,
    retry,
    memories,
    more: (): void => {
      setPrevious(memories)
      setCursor(data?.next ?? null)
    },
  }
}
