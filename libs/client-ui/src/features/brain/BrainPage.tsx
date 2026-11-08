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
import { BrainReview } from './BrainReview'
import { BrainGraph } from './BrainGraph'
import { BrainMemoryDetail, MEMORY_LABELS, memoryRelation } from './BrainMemory'
import { formatCount } from '@/lib/format'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'

export function BrainPage(): React.JSX.Element {
  useBrainSync()
  const supported = usePlatform().localBrain
  const status = useBrain((s) => s.status)
  const error = useBrain((s) => s.error)
  const openSettings = useOpenSettings()
  return (
    <PageShell
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
        <Button size="sm" onClick={() => openSettings('local', 'brain')}>
          Settings
        </Button>
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
  const [review, setReview] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState<string | null>(null)
  if (!data)
    return (
      <BrainEmpty title={error || 'Loading knowledge…'}>
        {error && <Button onClick={retry}>Retry</Button>}
      </BrainEmpty>
    )
  if (!jobs.length && !data.memories.length)
    return (
      <BrainEmpty title="No knowledge yet">
        Right-click a lane and choose Queue for knowledge extraction. Brain reads a private copy of
        it and proposes memories for you to approve.
      </BrainEmpty>
    )
  const reviewing =
    review && jobs.some((job) => job.id === review && job.state === 'review') ? review : null
  return (
    <ListDetail
      listLabel="Brain inbox and memories"
      detailLabel="Brain detail"
      open={!!reviewing || !!selected}
      onBack={() => {
        setReview(null)
        setSelected(null)
      }}
      backLabel="Brain"
      list={
        <>
          <BrainInbox jobs={jobs} onReview={setReview} />
          <MemoryList
            knowledge={data}
            selected={selected}
            focus={focus}
            onClearFocus={() => setFocus(null)}
            onSelect={(id) => {
              setSelected(id)
              setReview(null)
            }}
          />
        </>
      }
      detail={(back) => (
        <div className="h-full overflow-auto">
          {back}
          {reviewing ? (
            <BrainReview key={reviewing} jobId={reviewing} onClose={() => setReview(null)} />
          ) : !data.memories.length ? (
            <BrainEmpty title="Nothing approved yet">
              Approved memories, and a graph of what they connect, show up here.
            </BrainEmpty>
          ) : (
            <KnowledgeView
              data={data}
              selected={selected}
              focus={focus}
              onFocus={setFocus}
              onForget={() => setSelected(null)}
            />
          )}
        </div>
      )}
    />
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
                    {memoryRelation(memory, knowledge.entities)}
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
}: {
  data: BrainKnowledge
  selected: string | null
  focus: string | null
  onFocus: (id: string) => void
  onForget: () => void
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
      {selected && data.memories.some((memory) => memory.id === selected) && (
        <BrainMemoryDetail
          key={selected}
          id={selected}
          entities={data.entities}
          onFocus={onFocus}
          onForget={onForget}
        />
      )}
    </div>
  )
}
