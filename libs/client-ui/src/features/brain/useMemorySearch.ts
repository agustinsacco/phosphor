import { useMemo, useState } from 'react'
import type { BrainKnowledge, BrainMemory } from '@shared/brain'
import { memoryRelation } from './BrainMemory'
import { memoryEntityIds } from './graphModel'

export function useMemorySearch(knowledge: BrainKnowledge | null): {
  query: string
  setQuery: (query: string) => void
  memories: BrainMemory[]
  matches: Set<string> | null
} {
  const [query, setQuery] = useState('')
  const memories = useMemo(
    () =>
      (knowledge?.memories ?? []).filter((memory) =>
        `${memory.summary} ${memoryRelation(memory, knowledge?.entities ?? [])}`
          .toLocaleLowerCase()
          .includes(query.toLocaleLowerCase()),
      ),
    [knowledge, query],
  )
  const matches = useMemo(() => (query ? memoryEntityIds(memories) : null), [query, memories])
  return { query, setQuery, memories, matches }
}
