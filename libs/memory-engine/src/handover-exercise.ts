/**
 * A moved Brain's smoke test, run on a disposable copy of the upgraded file: the live store opens
 * it (retention included), the map draws, a keyword recall answers, a graph walk expands and the
 * newest undoable pre-move change undoes. The copy is thrown away; only the outcome is kept.
 */
import { openBrainSearch } from './search'
import { openBrainStore } from './store'
import type { SqliteConstructor } from './types'

export interface BrainCopyExercise {
  readonly overview: number
  readonly recalled: number
  readonly expanded: boolean
  /** `refused` is an outcome, not a failure: later work can depend on every change. */
  readonly undo: 'undone' | 'refused' | 'none'
}

export async function exerciseBrainCopy(
  Database: SqliteConstructor,
  path: string,
  now: number,
): Promise<BrainCopyExercise> {
  const store = openBrainStore({ path, Database })
  let undo: BrainCopyExercise['undo'] = 'none'
  let graph: ReturnType<typeof store.overview>
  try {
    graph = store.overview(50)
    const changes = store.tidyChanges(20)
    const target = changes.items.find((item) => item.undoable)
    if (target) {
      try {
        store.tidyUndo(target.id, changes.revision)
        undo = 'undone'
      } catch {
        undo = 'refused'
      }
    }
  } finally {
    store.close()
  }
  const overview = graph.nodes.length
  const entityId = graph.nodes[0]?.id ?? null
  const label = graph.nodes[0]?.label ?? null
  const search = openBrainSearch({ path, Database })
  try {
    await search.refresh()
    const recall = label
      ? search.recall({ query: label, vector: null, limit: 8, scope: null, branch: null, now })
      : null
    const expanded = entityId
      ? search.expand({ entityId, contextIds: [], limit: 8, scope: null, branch: null, now }) !==
        null
      : false
    return { overview, recalled: recall?.hits.length ?? 0, expanded, undo }
  } finally {
    search.close()
  }
}
