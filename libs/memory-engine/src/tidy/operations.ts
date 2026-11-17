import { settleFoldSuggestions } from './fold-ancestry'
import { clearSubject } from './suggestions'
import { all, transaction, type Context } from '../database'
import { entityNumber } from '../entities'
import { memoryNumber } from '../knowledge'
import { mergeRows } from '../merge'
import { bumpRevision } from '../prefs'
import { checkRevision, journal, undo } from './journal'
import { fingerprintMemories } from './fingerprints'
import { memoryActionGuards } from './action-guards'
import { conflictMemories, foldMemories } from './memory-actions'
import type { JournalInput } from './journal'
import type { Selection } from './rows'

export function mergeEntities(
  ctx: Context,
  source: string,
  target: string,
  expected: number,
  suggestionId?: string,
): string {
  return transaction(ctx, () => {
    checkRevision(ctx, expected)
    return mergeChange(ctx, source, target, suggestionId)
  })
}
export function mergeChange(
  ctx: Context,
  source: string,
  target: string,
  suggestionId?: string,
): string {
  const entities = [entityNumber(ctx, source), entityNumber(ctx, target)]
  const memories = all<{ memory: number }>(
    ctx,
    'SELECT memory FROM mentions WHERE entity IN (?,?)',
    ...entities,
  ).map((r) => r.memory)
  const id = journal(
    ctx,
    {
      kind: 'merge',
      subjects: { type: 'entity', first: source, second: target },
      selection: { entities, memories: [] },
      suggestionId,
    },
    () => mergeRows(ctx, source, target),
  )
  clearSubject(ctx, 'entity', source)
  fingerprintMemories(ctx, memories)
  bumpRevision(ctx)
  return id
}

export function memorySelection(ctx: Context, first: number, second: number): Selection {
  const memories = new Set([first, second])
  for (const row of all<{ source: number; target: number }>(
    ctx,
    'SELECT source,target FROM memory_links WHERE source IN (?,?) OR target IN (?,?)',
    first,
    second,
    first,
    second,
  )) {
    memories.add(row.source)
    memories.add(row.target)
  }
  return { entities: [], memories: [...memories] }
}
/** Caller owns the transaction, including suggestion closure. */
export function changeMemories(
  ctx: Context,
  sourceId: string,
  targetId: string,
  kind: 'fold' | 'dispute' | 'replace',
  options: Pick<JournalInput, 'automatic' | 'suggestionId'> = {},
): string {
  const source = memoryNumber(ctx, sourceId),
    target = memoryNumber(ctx, targetId)
  const refusal = memoryActionGuards[kind](ctx, source, target)
  if (refusal) throw new Error(refusal)
  const selection = memorySelection(ctx, source, target)
  const id = journal(
    ctx,
    {
      ...options,
      kind,
      selection,
      subjects: { type: 'memory', first: sourceId, second: targetId },
    },
    () =>
      kind === 'fold'
        ? foldMemories(ctx, source, target)
        : conflictMemories(ctx, source, target, kind === 'replace'),
  )
  if (kind === 'fold') {
    settleFoldSuggestions(ctx, id, sourceId, targetId)
    clearSubject(ctx, 'memory', sourceId)
  }
  fingerprintMemories(ctx, selection.memories)
  bumpRevision(ctx)
  return id
}
export function undoOperation(ctx: Context, id: string, expected: number): Selection {
  return undo(ctx, id, expected)
}
