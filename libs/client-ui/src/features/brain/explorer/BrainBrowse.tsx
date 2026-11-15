import { useCallback, useState } from 'react'
import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@shared/brain'
import { Button, NeutralSegmented } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { relativeTime } from '@/lib/time'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { ENTITY_LABELS, KindDot, KnowledgeHeading } from './KnowledgePrimitives'
import type { BrainVisit } from './trail'

export function BrainBrowse({
  onVisit,
}: {
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [kind, setKind] = useState<BrainEntityKind | ''>('')
  const revision = useBrain((s) => s.status?.revision)
  return <BrowsePages key={`${kind}:${revision}`} kind={kind} setKind={setKind} onVisit={onVisit} />
}
function BrowsePages({
  kind,
  setKind,
  onVisit,
}: {
  kind: BrainEntityKind | ''
  setKind: (kind: BrainEntityKind | '') => void
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [offset, setOffset] = useState(0)
  const load = useCallback(
    () => window.phosphor.invoke('brain:entities', kind || null, offset, 20),
    [kind, offset],
  )
  const { data, error, retry } = useBrainResource(load)
  const [previous, setPrevious] = useState<NonNullable<typeof data> | null>(null)
  const items = [
    ...new Map(
      [...(previous?.items ?? []), ...(data?.items ?? [])].map((item) => [item.entity.id, item]),
    ).values(),
  ]
  const kinds = data?.kinds ?? previous?.kinds ?? []
  return (
    <>
      <NeutralSegmented
        wrap
        value={kind}
        onChange={setKind}
        options={[
          { id: '', label: 'All' },
          ...BRAIN_ENTITY_KINDS.filter((k) => kinds.includes(k)).map((id) => ({
            id,
            label: ENTITY_LABELS[id],
          })),
        ]}
      />
      <section aria-label="Most connected">
        <KnowledgeHeading>Most connected</KnowledgeHeading>
        {items.map(({ entity, memories }) => (
          <TooltipButton
            className="brain-row"
            key={entity.id}
            onClick={() => onVisit({ kind: 'entity', id: entity.id, label: entity.label })}
          >
            <KindDot kind={entity.kind} />
            <span className="min-w-0">
              <span className="block font-medium">{entity.label}</span>
              <span className="text-text-tertiary text-sm">
                {entity.kind} · {memories} memories
              </span>
            </span>
          </TooltipButton>
        ))}
        {!data && (
          <p role="status" className="p-2 text-sm">
            {error || 'Loading people and things…'}
            {error && <Button onClick={retry}>Retry</Button>}
          </p>
        )}
        {data && !items.length && (
          <p className="text-text-tertiary p-2 text-sm">
            No knowledge yet. Right-click a lane and choose Queue for knowledge extraction.
          </p>
        )}
        {data?.more && (
          <TooltipButton
            className="text-text-secondary px-2 py-1 hover:underline"
            onClick={() => {
              setPrevious({ ...data, items })
              setOffset(offset + 20)
            }}
          >
            Show more
          </TooltipButton>
        )}
      </section>
      {!kind && <RecentMemories onVisit={onVisit} />}
    </>
  )
}
function RecentMemories({ onVisit }: { onVisit: (visit: BrainVisit) => void }): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:recent', 10), [])
  const { data, error, retry } = useBrainResource(load)
  return (
    <section aria-label="Recently learned">
      <KnowledgeHeading>Recently learned</KnowledgeHeading>
      {!data && (
        <p role="status" className="p-2 text-sm">
          {error || 'Loading recent memories…'}
          {error && <Button onClick={retry}>Retry</Button>}
        </p>
      )}
      {data?.items.map((m) => (
        <TooltipButton
          key={m.id}
          className="brain-row"
          onClick={() => onVisit({ kind: 'memory', id: m.id, label: m.summary })}
        >
          <span className="min-w-0">
            <span className="block">{m.summary}</span>
            <span className="text-text-tertiary text-sm">
              {m.type} · {m.originTitle ?? 'Unknown lane'} · {relativeTime(m.learnedAt)}
            </span>
          </span>
        </TooltipButton>
      ))}
    </section>
  )
}
