import { BRAIN_STRUCTURAL_PREDICATES, type BrainLink } from '@phosphor/shared/brain'
import { entity } from './entities'
import { edges } from './graph'
import type { Context } from './database'

/** At most 200 entities and 400 relations; structural routes get the third hop. */
export function walk(
  ctx: Context,
  seeds: string[],
  focus: Set<string>,
): { paths: BrainLink[][]; entities: Set<string>; memories: string[] } {
  const visited = new Set(seeds.slice(0, 200))
  const relationIds = new Set<string>()
  const paths: BrainLink[][] = []
  let frontier = [...visited].map((id) => ({ id, path: [] as BrainLink[] }))
  for (let depth = 0; depth < 3 && relationIds.size < 400; depth++) {
    const next: typeof frontier = []
    for (const current of frontier) {
      if (!focus.has(current.id) && entity(ctx, current.id)!.connections > 200) continue
      for (const link of edges(ctx, current.id)) {
        if (relationIds.has(link.id) || relationIds.size >= 400) continue
        if (
          depth === 2 &&
          ![...current.path, link].every((hop) =>
            (BRAIN_STRUCTURAL_PREDICATES as readonly string[]).includes(hop.predicate),
          )
        )
          continue
        const other = link.subjectId === current.id ? link.objectId : link.subjectId
        if (!visited.has(other) && visited.size >= 200) continue
        relationIds.add(link.id)
        const path = [...current.path, link]
        paths.push(path)
        if (!visited.has(other)) {
          visited.add(other)
          next.push({ id: other, path })
        }
      }
    }
    frontier = next
  }
  return {
    paths,
    entities: visited,
    memories: [...new Set(paths.flat().map((link) => link.memoryId))],
  }
}
