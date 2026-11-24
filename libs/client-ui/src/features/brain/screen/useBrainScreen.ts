import { useCallback, useState } from 'react'
import type { BrainEntity, BrainStatus } from '@shared/brain'
import type { BrainRecall } from '@shared/brain-recall'
import { ipcErrorText } from '@shared/errors'
import { brainToast } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import type { BrainVisit } from '../explorer/trail'
import { useEntityView } from '../explorer/useEntityView'
import type { MapOverlay } from '../map/useSentenceMap'
import type { MapStep } from '../map/SentenceMap'
import type { MemoryActions } from '../card/MemoryOpen'
import { moveWalk, NO_WALK, walkStep, walkTo, type Walk } from './walk'

export interface AskAnswerState {
  question: string
  recall: BrainRecall
}

/** Everything an answer's trails light: their links, and the people and things on them. */
export function answerOverlay(recall: BrainRecall): MapOverlay {
  const links = new Map(
    recall.hits.flatMap((hit) => hit.trail?.links ?? []).map((link) => [link.id, link]),
  )
  const ids = new Set([
    ...recall.hits.flatMap((hit) =>
      hit.trail ? [hit.trail.seedId, hit.trail.entityId] : hit.memory.entityIds,
    ),
    ...[...links.values()].flatMap((link) => [link.subjectId, link.objectId]),
  ])
  return { links: [...links.values()], entities: recall.entities.filter((e) => ids.has(e.id)) }
}

/** Where an answer's map starts: what the question named, else the first trail's seed. */
function answerCentre(recall: BrainRecall): string | null {
  return recall.focus[0] ?? recall.hits.find((hit) => hit.trail)?.trail?.seedId ?? null
}

/**
 * The one-screen page's state: the walk, what the map centres on (the step on screen, else
 * you, else the best-connected entity), an Ask answer and what the map lights.
 */
export function useBrainScreen(status: BrainStatus) {
  const [walk, setWalk] = useState<Walk>(NO_WALK)
  const [hops, setHops] = useState<1 | 2>(1)
  const [answer, setAnswer] = useState<AskAnswerState | null>(null)
  const [light, setLight] = useState<MapOverlay | null>(null)
  const [whole, setWhole] = useState(false)
  const [searching, setSearching] = useState(false)
  const [record, setRecord] = useState<{ jobId: string; title: string } | null>(null)
  const current = walk.steps[walk.index] ?? null
  const overview = useBrainResource(
    useCallback(() => window.phosphor.invoke('brain:overview'), []),
    !current && !status.ownerId,
  )
  const startId = status.ownerId ?? overview.data?.nodes[0]?.id ?? null
  const centreId = current?.id ?? startId
  const entity = useEntityView(centreId)
  const centreLabel = entity.data?.entity.label ?? current?.label ?? ''
  const step = (next: MapStep): void => {
    const from = current ?? (centreId ? { id: centreId, label: centreLabel } : next.to)
    const start = centreId ? { id: centreId, label: centreLabel } : null
    setWalk((old) => walkTo(old, start, walkStep(from, next.to, next.link)))
    setAnswer(null)
    setLight(null)
    setWhole(false)
  }
  const move = (delta: number): void => {
    setWalk((old) => moveWalk(old, delta))
    setLight(null)
  }
  const memoryActions: MemoryActions = {
    onEntity: (id, label) => step({ to: { id, label }, link: null }),
    onMap: (detail) =>
      setLight({
        links: detail.memory.links,
        entities: detail.entities.filter((e: BrainEntity) =>
          detail.memory.entityIds.includes(e.id),
        ),
      }),
    onOpenRead: (jobId) => setRecord({ jobId, title: 'this read' }),
  }
  /** Search lands on a person or thing, or on the first one a memory names, lit. */
  const visit = (target: BrainVisit): void => {
    if (target.kind === 'entity') {
      step({ to: target, link: null })
      return
    }
    window.phosphor
      .invoke('brain:memory', target.id)
      .then((detail) => {
        const first = detail.entities.find((e) => detail.memory.entityIds.includes(e.id))
        if (first) step({ to: first, link: null })
        memoryActions.onMap(detail)
      })
      .catch((cause: unknown) => brainToast(ipcErrorText(cause), 'error'))
  }
  const overlay = answer ? answerOverlay(answer.recall) : light
  return {
    walk,
    hops,
    setHops,
    answer,
    setAnswer,
    overlay,
    setLight,
    whole,
    setWhole,
    searching,
    setSearching,
    record,
    setRecord,
    entity,
    overviewError: overview.error,
    retryOverview: overview.retry,
    /** Nothing to centre on: Brain knows no one yet. */
    empty: !centreId && !!overview.data,
    centreId: (answer && answerCentre(answer.recall)) ?? centreId,
    centreLabel,
    trail: walk.steps.slice(1, walk.index + 1).flatMap((s) => (s.link ? [s.link] : [])),
    step,
    move,
    visit,
    jump: (index: number): void => setWalk((old) => ({ ...old, index })),
    memoryActions,
  }
}
export type BrainScreenState = ReturnType<typeof useBrainScreen>
