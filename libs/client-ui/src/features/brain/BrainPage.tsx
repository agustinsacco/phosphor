import { useState } from 'react'
import { BRAIN_MEMORY_TYPES, type BrainKnowledge } from '@shared/brain'
import { PageShell } from '@/components/PageShell'
import { ListDetail } from '@/components/ListDetail'
import { Button, TextInput } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { usePlatform } from '@/platform/Platform'
import { useBrain, useBrainSync } from './useBrain'
import { useBrainResource } from './useBrainResource'
import { BrainInbox } from './BrainInbox'
import { useBrainSelection } from './useBrainSelection'
import { BrainExtraction } from './BrainExtraction'
import { BrainReview } from './BrainReview'
import { BrainGraph } from './BrainGraph'
import { BrainMemoryDetail, MEMORY_LABELS, memoryRelation } from './BrainMemory'
import { formatCount } from '@/lib/format'
import { relativeTimeShort } from '@/lib/time'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'

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
          {status && status.counts.memories > 0 && (
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
        <BrainEmpty title="Brain is available on Desktop" />
      ) : !status ? (
        <BrainEmpty title={error || 'Loading Brain…'}>
          <Button
            onClick={() => {
              void useBrain.getState().refresh()
            }}
          >
            Retry
          </Button>
        </BrainEmpty>
      ) : (
        <BrainContent revision={status.revision} />
      )}
    </PageShell>
  )
}

const loadKnowledge = (): Promise<BrainKnowledge> => window.phosphor.invoke('brain:knowledge')

function BrainContent({ revision }: { revision: number }): React.JSX.Element {
  const { data, error, retry } = useBrainResource(loadKnowledge, revision)
  const jobs = useBrain((s) => s.status?.jobs ?? [])
  const {
    review,
    selected,
    extraction,
    showReview,
    showMemory,
    showExtraction,
    closeReview,
    closeMemory,
    closeExtraction,
    back,
  } = useBrainSelection()
  const [focus, setFocus] = useState<string | null>(null)
  if (!data)
    return (
      <BrainEmpty title={error || 'Loading knowledge…'}>
        {error && <Button onClick={retry}>Retry</Button>}
      </BrainEmpty>
    )
  if (!jobs.length && !data.memories.length) return <BrainWelcome />
  const reviewing =
    review && jobs.some((job) => job.id === review && job.state === 'review') ? review : null
  return (
    <ListDetail
      listLabel="Brain inbox and memories"
      detailLabel="Brain detail"
      open={!!extraction || !!reviewing || !!selected}
      onBack={back}
      backLabel="Brain"
      list={
        <>
          <BrainInbox jobs={jobs} onReview={showReview} onExtraction={showExtraction} />
          <MemoryList
            knowledge={data}
            selected={selected}
            focus={focus}
            onClearFocus={() => setFocus(null)}
            onSelect={showMemory}
          />
        </>
      }
      detail={(back) => (
        <div className="h-full overflow-auto">
          {back}
          {extraction ? (
            <BrainExtraction
              key={extraction}
              jobId={extraction}
              onBack={closeExtraction}
              onMemory={showMemory}
            />
          ) : reviewing ? (
            <BrainReview
              key={reviewing}
              jobId={reviewing}
              onClose={closeReview}
              onExtraction={showExtraction}
            />
          ) : !data.memories.length && !selected ? (
            <BrainEmpty title="Nothing approved yet">
              Approved memories, and a graph of what they connect, show up here.
            </BrainEmpty>
          ) : (
            <KnowledgeView
              data={data}
              selected={selected}
              focus={focus}
              onFocus={setFocus}
              onForget={closeMemory}
              onExtraction={showExtraction}
            />
          )}
        </div>
      )}
    />
  )
}

function BrainWelcome(): React.JSX.Element {
  return (
    <BrainEmpty title="No knowledge yet">
      Right-click a lane and choose Queue for knowledge extraction. Brain reads a private copy of it
      and proposes memories for you to approve.
    </BrainEmpty>
  )
}

function MemoryList({
  knowledge,
  selected,
  focus,
  onClearFocus,
  onSelect,
}: {
  knowledge: BrainKnowledge
  selected: string | null
  focus: string | null
  onClearFocus: () => void
  onSelect: (id: string) => void
}): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  if (!knowledge.memories.length) return null
  const focused = knowledge.entities.find((entity) => entity.id === focus)
  const memories = knowledge.memories.filter(
    (memory) =>
      (!focused || memory.subjectId === focus || memory.objectId === focus) &&
      `${memory.summary} ${memoryRelation(memory, knowledge.entities)}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  )
  return (
    <section aria-label="Memories" className="space-y-3 p-3">
      <TextInput
        aria-label="Search memories"
        placeholder="Search memories"
        className="w-full"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {focused && (
        <Button size="xs" className="bg-accent-soft" onClick={onClearFocus}>
          About {focused.label} ×
        </Button>
      )}
      {knowledge.truncated && (
        <p className="text-text-tertiary text-sm">
          Showing the newest {knowledge.memories.length} memories.
        </p>
      )}
      {!memories.length && <p className="text-text-tertiary text-sm">No matching memories</p>}
      {BRAIN_MEMORY_TYPES.map((type) => {
        const group = memories.filter((memory) => memory.type === type)
        return (
          group.length > 0 && (
            <section key={type}>
              <SectionLabel>
                {MEMORY_LABELS[type]} · {group.length}
              </SectionLabel>
              {group.map((memory) => (
                <TooltipButton
                  key={memory.id}
                  className={`mb-1 block w-full rounded-md p-2 text-left ${selected === memory.id ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}
                  onClick={() => onSelect(memory.id)}
                >
                  <span className="line-clamp-2 text-base">{memory.summary}</span>
                  <span className="text-text-tertiary mt-1 block truncate text-sm">
                    {memoryRelation(memory, knowledge.entities)} ·{' '}
                    {relativeTimeShort(memory.observedAt)}
                  </span>
                </TooltipButton>
              ))}
            </section>
          )
        )
      })}
    </section>
  )
}

function BrainEmpty({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-8 text-center">
      <h2 className="text-text-secondary text-lg font-medium">{title}</h2>
      <div className="text-text-tertiary max-w-md text-sm">{children}</div>
    </div>
  )
}

function KnowledgeView({
  data,
  selected,
  focus,
  onFocus,
  onForget,
  onExtraction,
}: {
  data: BrainKnowledge
  selected: string | null
  focus: string | null
  onFocus: (id: string) => void
  onForget: () => void
  onExtraction: (jobId: string) => void
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      {data.entities.length > 0 && (
        <BrainGraph
          entities={data.entities}
          memories={data.memories}
          focus={focus}
          onFocus={onFocus}
        />
      )}
      {selected && (
        <BrainMemoryDetail
          key={selected}
          id={selected}
          entities={data.entities}
          onFocus={onFocus}
          onForget={onForget}
          onExtraction={onExtraction}
        />
      )}
    </div>
  )
}
