import { useCallback, useState } from 'react'
import { brainLinkSentence, type BrainEntity } from '@shared/brain'
import type { BrainRoutes, BrainRouteStep } from '@shared/brain-recall'
import { Button } from '@/components/form'
import { useBrainResource } from '../useBrainResource'
import type { MapOverlay } from '../map/useSentenceMap'

/** A route's step as a sentence: a relationship, or two names that appear together. */
export function routeStepWords(step: BrainRouteStep, entities: BrainEntity[]): string {
  const label = (id: string): string => entities.find((e) => e.id === id)?.label ?? 'Unknown'
  return step.kind === 'relation'
    ? brainLinkSentence(step.link, label(step.link.subjectId), label(step.link.objectId))
    : `${label(step.fromId)} and ${label(step.toId)} appear together in ${step.shared === 1 ? 'a memory' : `${step.shared} memories`}`
}

function routeOverlay(data: BrainRoutes, route: BrainRouteStep[]): MapOverlay {
  const ids = new Set(
    route.flatMap((step) =>
      step.kind === 'relation'
        ? [step.link.subjectId, step.link.objectId]
        : [step.fromId, step.toId],
    ),
  )
  return {
    links: route.flatMap((step) => (step.kind === 'relation' ? [step.link] : [])),
    entities: data.entities.filter((e) => ids.has(e.id)),
  }
}

/** How two people or things connect, as sentences, each route lit on the map on request. */
export function CardRoutes({
  from,
  to,
  onLight,
}: {
  from: string
  to: string
  onLight: (overlay: MapOverlay) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:path', from, to), [from, to])
  const { data, error, retry } = useBrainResource(load)
  const [selected, setSelected] = useState<number | null>(null)
  if (!data)
    return (
      <p role="status" className="text-sm">
        {error || 'Finding how they connect…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  if (data.status !== 'ok' || !data.routes.length)
    return <p className="text-text-secondary text-sm">No connection within four steps.</p>
  return (
    <section aria-label="Routes" className="space-y-2">
      {data.routes.map((route, index) => (
        <article key={index} className="border-border space-y-1 rounded-md border p-2 text-sm">
          <ol className="space-y-0.5">
            {route.map((step, at) => (
              <li key={at}>{routeStepWords(step, data.entities)}</li>
            ))}
          </ol>
          <Button
            size="xs"
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index)
              onLight(routeOverlay(data, route))
            }}
          >
            Show on the map
          </Button>
        </article>
      ))}
    </section>
  )
}
