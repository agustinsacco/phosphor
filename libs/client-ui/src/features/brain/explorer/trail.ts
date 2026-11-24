/** Where search, the whole graph or a merge sends the page: a person or thing, or a memory. */
export type BrainVisit =
  | { kind: 'entity'; id: string; label: string; memoryId?: string }
  | { kind: 'memory'; id: string; label: string }
