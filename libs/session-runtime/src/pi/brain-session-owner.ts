import type { SessionMeta } from '@phosphor/shared/models'

/** The trusted processor extension writes this before any job content is captured. */
export const BRAIN_OWNER_CUSTOM_TYPE = 'phosphor-brain-owner'
export type BrainSessionOwner = NonNullable<SessionMeta['brainOwner']>

export function brainOwnerFromEntry(entry: Record<string, unknown>): BrainSessionOwner | undefined {
  if (entry.type !== 'custom' || entry.customType !== BRAIN_OWNER_CUSTOM_TYPE) return undefined
  const data = entry.data as Partial<BrainSessionOwner> | null | undefined
  if (data?.kind !== 'brain' || typeof data.jobId !== 'string' || !data.jobId.trim())
    return undefined
  return { kind: 'brain', jobId: data.jobId }
}
