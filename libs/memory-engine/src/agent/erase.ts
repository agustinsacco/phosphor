import { BRAIN_ERASE_LIMIT, BRAIN_ERASE_LIMIT_REFUSAL } from '@phosphor/shared/brain-agent'
import { one, transaction, type Context } from '../database'
import { removeMemory } from '../merge'
import { pruneExtractions } from '../extractions'
import { bumpKnowledgeRevision } from '../prefs'
import { journal } from '../tidy/journal'
import { cleanNote } from './notes'
import type { BrainChangeNote } from './types'

function quotesMemory(reason: string, summary: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/gu, ' ').trim()
  const text = normalize(summary),
    why = normalize(reason)
  if (text.length < 40) return why.includes(text)
  for (let i = 0; i <= text.length - 40; i++) if (why.includes(text.slice(i, i + 40))) return true
  return false
}
export function erase(ctx: Context, memoryId: string, rawNote: BrainChangeNote): string {
  const note = cleanNote(rawNote)
  return transaction(ctx, () => {
    const memory = one<{ summary: string }>(
      ctx,
      'SELECT summary FROM memories WHERE id=?',
      memoryId,
    )
    if (!memory) throw new Error('Brain memory not found.')
    if (quotesMemory(note.reason, memory.summary))
      throw new Error('Give a reason without quoting the memory; nothing changed.')
    const count = one<{ n: number }>(
      ctx,
      `SELECT COUNT(*) AS n FROM tidy_operations o JOIN agent_notes a ON a.operation_id=o.id AND a.role='made' WHERE o.kind='erase' AND o.created_at>=?`,
      ctx.now() - 3_600_000,
    )!.n
    if (count >= BRAIN_ERASE_LIMIT) throw new Error(BRAIN_ERASE_LIMIT_REFUSAL)
    // No row images: an erasure can never restore the memory or its text.
    const id = journal(
      ctx,
      {
        kind: 'erase',
        note,
        subjects: { type: 'memory', first: memoryId, second: memoryId },
        selection: { entities: [], memories: [] },
      },
      () => removeMemory(ctx, memoryId),
    )
    bumpKnowledgeRevision(ctx)
    pruneExtractions(ctx)
    return id
  })
}
