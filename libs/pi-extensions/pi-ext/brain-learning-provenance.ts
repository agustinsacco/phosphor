/** A generated contribution inherits original input roots; it is not a new witness.
 * Branch/custom summaries without a selected-ancestry proof are deliberately unsupported.
 */
export function learningProvenance(
  branch: unknown[],
  projectedIds: Set<string>,
): Map<string, string[]> {
  const roots: string[] = []
  const result = new Map<string, string[]>()
  for (const value of branch) {
    const entry = value as { id: string; type: string; message?: { role?: string } }
    const original =
      entry.type === 'message' && ['user', 'toolResult'].includes(entry.message?.role ?? '')
    if (original) roots.push(entry.id)
    if (!projectedIds.has(entry.id)) continue
    if (original) result.set(entry.id, [entry.id])
    else if (
      entry.type === 'compaction' ||
      (entry.type === 'message' && entry.message?.role === 'assistant')
    ) {
      if (roots.length > 1000) throw new Error('Learning source provenance exceeds 1000 roots')
      result.set(entry.id, [...roots])
    }
  }
  return result
}
