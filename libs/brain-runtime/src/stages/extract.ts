import type { BrainStore } from '@phosphor/memory-engine/types'
import type { ExtractedPart, Registry, StageAsk, StageExtraction } from '../stage-types'
import type { TranscriptWindow } from '../windows'
import { segmentInputs } from '../stage-input'
import type { TranscriptSegment } from '@phosphor/memory-engine/types'
import { inputHash, splitWindow } from '../windows'
import { EXTRACT_CAP } from '../constants'
import { extractPrompt } from '../stage-prompts/extract'
import { wholePhrase } from '../text'
import { parseStageExtraction } from '../stage-parse'

export async function extractWindows(
  jobId: string,
  windows: TranscriptWindow[],
  store: BrainStore,
  ask: StageAsk,
  progress: (done: number, total: number) => void,
  source: TranscriptSegment[],
): Promise<ExtractedPart[]> {
  const output: ExtractedPart[] = []
  const registry: Registry = []
  const pending = windows.map((window, i) => ({ window, key: `w${i + 1}` }))
  let calls = 0
  while (pending.length) {
    const { window, key } = pending.shift()!
    const selected = [...registry]
      .reverse()
      .sort(
        (a, b) =>
          Number([b.label, ...b.aliases].some((n) => wholePhrase(window.text, n))) -
          Number([a.label, ...a.aliases].some((n) => wholePhrase(window.text, n))),
      )
      .slice(0, 60)
    const offered = selected.map((e, i) => ({ ...e, ref: `r${i + 1}` }))
    const prompt = extractPrompt(window, offered)
    const hash = inputHash(prompt)
    const saved = store.part(jobId, key, hash)
    const extraction = saved
      ? (JSON.parse(saved.output) as StageExtraction)
      : await ask(
          'extract',
          ++calls,
          prompt,
          (answer) => parseStageExtraction(answer, window, offered),
          window.segments.map((s) => s.entryId),
          { registry: offered, segments: segmentInputs(window.segments, source) },
        )
    if (!saved)
      store.savePart(jobId, { part: key, inputHash: hash, output: JSON.stringify(extraction) })
    const capped =
      extraction.claims.length >= EXTRACT_CAP || extraction.entities.length >= EXTRACT_CAP
    if (capped && window.segments.length > 1) {
      pending.unshift(...splitWindow(window).map((w, i) => ({ window: w, key: `${key}.${i + 1}` })))
      continue
    }
    // Registry handles map back to the prior job refs; all new refs become window-local.
    const redirects = new Map(offered.map((e, i) => [e.ref, selected[i]!.ref]))
    for (const e of extraction.entities) redirects.set(e.ref, `${key}:${e.ref}`)
    const resolve = (id: string): string => redirects.get(id) ?? id
    const renamed: StageExtraction = {
      entities: extraction.entities.map((e) => ({ ...e, ref: resolve(e.ref) })),
      claims: extraction.claims.map((c) => ({
        ...c,
        ref: `${key}:${c.ref}`,
        mentions: c.mentions.map(resolve),
        links: c.links.map((l) => ({
          ...l,
          subject: resolve(l.subject),
          object: resolve(l.object),
        })),
      })),
      parents: extraction.parents.map((p) => ({
        ...p,
        entity: resolve(p.entity),
        claim: p.claim ? `${key}:${p.claim}` : null,
      })),
    }
    registry.push(...renamed.entities)
    output.push({ key, window, extraction: renamed, truncated: capped })
    progress(output.length, output.length + pending.length)
  }
  return output
}
