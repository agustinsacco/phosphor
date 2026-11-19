import { sourceCheckpoint } from '../source-checkpoint'
import { BRAIN_STRUCTURAL_PREDICATES } from '@phosphor/shared/brain'
import type { BrainStore, TranscriptSegment } from '@phosphor/memory-engine/types'
import type { Registry, StageAsk, StageExtraction, StageLinks } from '../stage-types'
import type { TranscriptWindow } from '../windows'
import { inputHash } from '../windows'
import { linksInput } from '../stage-links-input'
import { rebuildPrompt } from '../stage-input'
import { parseStageLinks } from '../stage-links-parse'

export async function addLinks(
  jobId: string,
  key: string,
  extraction: StageExtraction,
  registry: Registry,
  window: TranscriptWindow,
  source: TranscriptSegment[],
  store: BrainStore,
  ask: StageAsk,
): Promise<StageExtraction> {
  const input = linksInput(extraction, registry, window, source)
  if (!input.rows.length) return extraction
  const prompt = rebuildPrompt('links', { links: input }, source)
  const hash = inputHash(prompt),
    part = `links:${key}`
  const saved = sourceCheckpoint(store, jobId, part, hash)
  const result = saved
    ? (JSON.parse(saved.output) as StageLinks)
    : await ask(
        'links',
        1,
        prompt,
        (answer) => parseStageLinks(answer, window, extraction, input),
        [...new Set(input.rows.flatMap((r) => r.excerpts.map((e) => e.entryId)))],
        { links: input },
      )
  if (!saved) store.savePart(jobId, { part, inputHash: hash, output: JSON.stringify(result) })
  return {
    ...extraction,
    outcomes: [...(extraction.outcomes ?? []), ...result.outcomes],
    claims: extraction.claims.map((c) => ({
      ...c,
      links: [
        ...c.links,
        ...result.links.filter((l) => l.claim === c.ref).map(({ claim: _claim, ...link }) => link),
      ],
    })),
    parents: extraction.parents.map((p) => {
      const supporting = result.links.find(
        (l) => l.subject === p.entity && BRAIN_STRUCTURAL_PREDICATES.some((v) => v === l.predicate),
      )
      return p.status === 'not_stated' && supporting
        ? { ...p, status: 'stated', claim: supporting.claim }
        : p
    }),
  }
}
