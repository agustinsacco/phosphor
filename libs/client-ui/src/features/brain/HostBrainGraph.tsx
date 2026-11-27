import { useCallback, useState } from 'react'
import { type BrainGraph } from '@shared/brain'
import type { HostBrainMap } from '@shared/host-brain'
import { Button, NeutralSegmented } from '@/components/form'
import { useBrainRequest, type ReadyBrainSurface } from './useHostBrain'
import { CardRelations, CardTogether } from './card/CardRelations'
import { HostWholeGraph } from './HostWholeGraph'
import { HostEntityEdits } from './HostEntityEdits'
import type { MapStep } from './map/SentenceMap'
import { HostNeighbourMap } from './HostNeighbourMap'
import { HostGraphAsk, HostGraphSearch } from './HostGraphQueries'
import { HostCardRoutes } from './HostCardRoutes'
import { useHostGraphWalk } from './useHostGraphWalk'
import { WalkTrail } from './map/WalkTrail'
import type { MapOverlay } from './map/useSentenceMap'

export function HostBrainGraph({
  brain,
  onTell,
  openMemory,
}: {
  brain: ReadyBrainSurface
  onTell: () => void
  openMemory: (id: string) => void
}) {
  const [whole, setWhole] = useState(false)
  const [hops, setHops] = useState<1 | 2>(1)
  const [overlay, setOverlay] = useState<MapOverlay | null>(null)
  const overview = useBrainRequest<'brain:overview'>(brain, { method: 'brain:overview', args: [] })
  const initial = brain.status.ownerId ?? overview.data?.nodes[0]?.id ?? null
  const clearOverlay = useCallback(() => setOverlay(null), [])
  const label = (id: string) => overview.data?.nodes.find((node) => node.id === id)?.label ?? id
  const walk = useHostGraphWalk(
    initial ? { id: initial, label: label(initial) } : null,
    clearOverlay,
  )
  const centre = walk.place?.id ?? null
  const visit = (id: string) => walk.step({ to: { id, label: label(id) }, link: null })
  return (
    <section aria-label="Knowledge graph" className="space-y-3">
      <HostGraphSearch brain={brain} step={walk.step} openMemory={openMemory} />
      <WalkTrail
        walk={walk.walk}
        start={walk.place?.label ?? null}
        onMove={walk.move}
        onJump={walk.jump}
      />
      {whole ? (
        <HostWholeGraph
          brain={brain}
          overview={overview.data}
          focus={centre}
          overlay={overlay}
          trail={walk.trail}
          visit={visit}
          close={() => setWhole(false)}
          openMemory={openMemory}
        />
      ) : (
        <>
          <MapControls hops={hops} setHops={setHops} onWhole={() => setWhole(true)} />
          <NeighbourMap
            brain={brain}
            centre={centre}
            hops={hops}
            walk={walk}
            overview={overview}
            overlay={overlay}
          />
        </>
      )}
      {centre && (
        <EntityCard
          key={centre}
          brain={brain}
          id={centre}
          step={walk.step}
          visit={visit}
          onLight={setOverlay}
          openMemory={openMemory}
        />
      )}
      <HostGraphAsk
        brain={brain}
        onTell={onTell}
        openMemory={openMemory}
        onAnswer={(recall) => lightAnswer(recall, walk.step, setOverlay)}
      />
    </section>
  )
}

function NeighbourMap({
  brain,
  centre,
  hops,
  walk,
  overview,
  overlay,
}: {
  brain: ReadyBrainSurface
  centre: string | null
  hops: 1 | 2
  walk: ReturnType<typeof useHostGraphWalk>
  overview: { data: BrainGraph | undefined; error: boolean; retry: () => void }
  overlay: MapOverlay | null
}) {
  const graph = useBrainRequest<'brain:neighbourhood'>(
    brain,
    centre ? { method: 'brain:neighbourhood', args: [centre, hops] } : null,
  )
  return (
    <HostNeighbourMap
      graph={graph.data}
      centre={centre}
      overlay={overlay}
      step={walk.step}
      trail={walk.trail}
      hops={hops}
      error={graph.error || overview.error}
      retry={centre ? graph.retry : overview.retry}
      empty={!!overview.data && !centre}
    />
  )
}

function lightAnswer(
  recall: HostBrainMap['brain:ask']['result'],
  step: (step: MapStep) => void,
  light: (overlay: MapOverlay) => void,
) {
  const focus = recall.focus[0] ?? recall.hits[0]?.trail?.seedId
  if (focus)
    step({
      to: recall.entities.find((entity) => entity.id === focus) ?? { id: focus, label: focus },
      link: null,
    })
  light({
    entities: recall.entities,
    links: recall.hits.flatMap((hit) => [...hit.memory.links, ...(hit.trail?.links ?? [])]),
  })
}

function MapControls({
  hops,
  setHops,
  onWhole,
}: {
  hops: 1 | 2
  setHops: (n: 1 | 2) => void
  onWhole: () => void
}) {
  return (
    <>
      <NeutralSegmented
        value={hops === 1 ? '1' : '2'}
        options={[
          { id: '1', label: '1 step' },
          { id: '2', label: '2 steps' },
        ]}
        onChange={(value) => setHops(value === '1' ? 1 : 2)}
      />{' '}
      <Button size="sm" onClick={onWhole}>
        Whole graph
      </Button>
    </>
  )
}

function EntityCard({
  brain,
  id,
  step,
  visit,
  onLight,
  openMemory,
}: {
  brain: ReadyBrainSurface
  id: string
  step: (step: MapStep) => void
  visit: (id: string) => void
  onLight: (overlay: MapOverlay) => void
  openMemory: (id: string) => void
}) {
  const entity = useBrainRequest<'brain:entity'>(brain, { method: 'brain:entity', args: [id] })
  const [cursor, setCursor] = useState<string | null>(null)
  const memories = useBrainRequest<'brain:entityMemories'>(brain, {
    method: 'brain:entityMemories',
    args: [id, {}, cursor],
  })
  const card = entity.data
  if (!card)
    return (
      <p role="status">
        {entity.error ? (
          <>
            The Host did not provide this card. <Button onClick={entity.retry}>Retry</Button>
          </>
        ) : (
          'Loading card…'
        )}
      </p>
    )
  return (
    <section aria-label="Card">
      <h2>{card.entity.label}</h2>
      {card.entity.description && <p>{card.entity.description}</p>}
      {brain.access.includes('configure') && (
        <HostEntityEdits brain={brain} view={card} visit={visit} />
      )}
      <HostCardRoutes brain={brain} from={id} onLight={onLight} />
      <CardRelations view={card} onStep={step} />
      <CardTogether view={card} onStep={step} />
      {memories.error && (
        <p role="status">
          The Host did not provide memories. <Button onClick={memories.retry}>Retry</Button>
        </p>
      )}
      {memories.data && (
        <ul>
          {memories.data.memories.map(({ id, summary }) => (
            <li key={id}>
              {brain.access.includes('evidence') ? (
                <Button onClick={() => openMemory(id)}>{summary}</Button>
              ) : (
                summary
              )}
            </li>
          ))}
        </ul>
      )}
      {memories.data?.next && (
        <Button onClick={() => setCursor(memories.data!.next)}>More memories</Button>
      )}
      {cursor && <Button onClick={() => setCursor(null)}>First page</Button>}
    </section>
  )
}
