import { useCallback, useMemo } from 'react'
import {
  brainLinkEnded,
  brainLinkSentence,
  brainLinkWords,
  type BrainEntity,
  type BrainEntitySummary,
  type BrainLink,
} from '@shared/brain'
import { useBrainResource } from '../useBrainResource'
import { layoutMap, type MapEdge, type MapLayout } from '../explorer/mapLayout'

/** Links and people or things to light on top of the neighbourhood: an answer's trails. */
export interface MapOverlay {
  links: BrainLink[]
  entities: BrainEntity[]
}
export interface SentenceEdge extends MapEdge<BrainLink> {
  /** Every link of the edge as a sentence, subject to object. */
  sentences: string[]
  /** The short wording drawn on the line, with "until" for an ended link. */
  words: string
  ended: boolean
}

const day = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** The words drawn on a line: "reports to", or "worked on · until 2026-08-15". */
export function edgeWords(link: BrainLink, now: number): string {
  const words = brainLinkWords(link)
  return brainLinkEnded(link, now) && link.validTo !== null
    ? `${words} · until ${day(link.validTo)}`
    : words
}

function asSummary(entity: BrainEntity): BrainEntitySummary {
  return { ...entity, memories: 1, connections: 0 }
}

/** The centre's neighbourhood from Brain, with the overlay merged in, laid out for its box. */
export function useSentenceMap(
  centreId: string,
  hops: 1 | 2,
  overlay: MapOverlay | null,
  width: number,
  height: number,
) {
  const load = useCallback(
    () => window.phosphor.invoke('brain:neighbourhood', centreId, hops),
    [centreId, hops],
  )
  const { data, error, retry } = useBrainResource(load)
  const result = useMemo(() => {
    if (!data) return null
    // What has ended is decided when Brain answers; the next load redraws it.
    const now = Date.now()
    const nodes = new Map(data.nodes.map((node) => [node.id, node]))
    for (const entity of overlay?.entities ?? [])
      if (!nodes.has(entity.id)) nodes.set(entity.id, asSummary(entity))
    const links = new Map([...data.links, ...data.ended].map((link) => [link.id, link]))
    for (const link of overlay?.links ?? []) if (!links.has(link.id)) links.set(link.id, link)
    const layout = layoutMap({
      centerId: centreId,
      nodes: [...nodes.values()],
      links: [...links.values()],
      hops: overlay?.links.length ? 2 : hops,
      width,
      height,
    })
    const label = (id: string): string => nodes.get(id)?.label ?? id
    return { layout: withSentences(layout, label, now), label: label(centreId) }
  }, [data, overlay, centreId, hops, width, height])
  return { map: result, error, retry, truncated: data?.truncated ?? false }
}

export function withSentences(
  layout: MapLayout<BrainLink>,
  label: (id: string) => string,
  now: number,
): { nodes: MapLayout['nodes']; edges: SentenceEdge[]; hidden: number } {
  return {
    ...layout,
    edges: layout.edges.map((edge) => ({
      ...edge,
      sentences: edge.links.map((link) =>
        brainLinkSentence(link, label(link.subjectId), label(link.objectId)),
      ),
      words: edge.links.map((link) => edgeWords(link, now)).join(' · '),
      ended: edge.links.every((link) => brainLinkEnded(link, now)),
    })),
  }
}
