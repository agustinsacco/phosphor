import type {
  BrainTidyJudgement,
  BrainTidyPair,
  BrainTidyVerdict,
} from '@phosphor/shared/brain-tidy'
import { scrubExcerpt } from '@phosphor/memory-engine/secrets'
import { array, jsonAnswer, object, text } from '../stage-parse'

export function parseTidy(answer: string, pairs: BrainTidyPair[], model: string) {
  const judgements: BrainTidyJudgement[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const raw of array(jsonAnswer(answer).decisions)) {
    try {
      const row = object(raw)
      const ref = text(row.ref)
      const pair = /^P[1-9]\d*$/.test(ref) ? pairs[Number(ref.slice(1)) - 1] : undefined
      if (!pair || seen.has(ref)) throw new Error('Unknown or duplicate pair')
      const reason = scrubExcerpt(text(row.reason)).trim()
      if (!reason || reason.length > 300) throw new Error('Invalid reason')
      const kind = row.verdict
      if (!['same', 'different', 'conflict', 'replaces'].includes(String(kind)))
        throw new Error('Invalid verdict')
      const keys =
        kind === 'replaces' ? ['ref', 'verdict', 'reason', 'newer'] : ['ref', 'verdict', 'reason']
      if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error('Unknown field')
      if (
        (kind === 'conflict' || kind === 'replaces') &&
        pair.subjects.some((s) => s.type !== 'memory')
      )
        throw new Error('Entity conflict')
      let verdict: BrainTidyVerdict
      if (kind === 'replaces') {
        if (row.newer !== 'a' && row.newer !== 'b') throw new Error('Invalid newer side')
        verdict = { kind, reason, newerId: pair.subjects[row.newer === 'a' ? 0 : 1].id }
      } else verdict = { kind: kind as 'same' | 'different' | 'conflict', reason }
      judgements.push({ suggestionId: pair.suggestionId, model, verdict })
      seen.add(ref)
    } catch {
      dropped++
    }
  }
  return { judgements, dropped, missing: pairs.length - judgements.length }
}
