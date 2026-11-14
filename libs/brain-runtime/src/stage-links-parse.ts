import type { StageExtraction, StageLinks, LinksInput } from './stage-types'
import type { TranscriptWindow } from './windows'
import { array, jsonAnswer, object, parseLink, text, tolerant } from './stage-parse'

export function parseStageLinks(
  answer: string,
  window: TranscriptWindow,
  extraction: StageExtraction,
  input: LinksInput,
): StageLinks {
  const outcomes: StageLinks['outcomes'] = []
  const kinds = new Map(input.entities.map((e) => [e.ref, e.kind]))
  const key = (l: { subject: string; predicate: string; object: string }) =>
    JSON.stringify([l.subject, l.predicate, l.object])
  const seen = new Set(extraction.claims.flatMap((c) => c.links.map(key)))
  const links = tolerant(
    array(jsonAnswer(answer).links),
    (value) => {
      const raw = object(value)
      const claim = text(raw.claim)
      const row = input.rows.find((r) => r.ref === claim)
      if (!row) throw new Error('Unknown links claim')
      for (const endpoint of [raw.subject, raw.object])
        if (typeof endpoint !== 'string' || !row.mentions.includes(endpoint))
          throw new Error('Link endpoint is not mentioned by this claim')
      const link = parseLink(raw, kinds, window)
      if (!row.excerpts.some((e) => e.segment === link.segment))
        throw new Error("Link quote is not from this claim's excerpts")
      if (seen.has(key(link))) throw new Error('Duplicate link in this part')
      seen.add(key(link))
      return { claim, ...link }
    },
    (_value, index) => `links[${index + 1}]`,
    outcomes,
  )
  return { links, outcomes }
}
