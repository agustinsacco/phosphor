/** Signed, additive Brain rights; deliberately not members of the v1 capability arrays. */
export const BRAIN_ACCESS = ['read', 'control', 'evidence', 'configure'] as const
export type BrainAccess = (typeof BRAIN_ACCESS)[number]

export function parseBrainAccess(value: unknown): BrainAccess[] | null {
  if (!Array.isArray(value) || value.length > BRAIN_ACCESS.length) return null
  const rights: BrainAccess[] = []
  for (const item of value) {
    const right = BRAIN_ACCESS.find((known) => known === item)
    if (!right || rights.includes(right)) return null
    rights.push(right)
  }
  return rights
}
