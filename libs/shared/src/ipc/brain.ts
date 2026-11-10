import type {
  BrainExtractionView,
  BrainKnowledge,
  BrainLaneRef,
  BrainMemoryDetail,
  BrainPrefs,
  BrainProposalView,
  BrainStatus,
} from '../brain'

/** UI commands. Authority comes from the Desktop handler, never this DTO. */
export interface BrainInvokeMap {
  'brain:status': { args: []; result: BrainStatus }
  /** Saves at once. Enabling downloads the model if it is missing; disabling keeps it. */
  'brain:setPrefs': { args: [prefs: BrainPrefs]; result: BrainStatus }
  /** Retries a failed model download. */
  'brain:download': { args: []; result: BrainStatus }
  'brain:removeModel': { args: []; result: BrainStatus }
  'brain:queue': { args: [lane: BrainLaneRef]; result: BrainStatus }
  /** Cancels a waiting, queued or running job, or dismisses an empty or failed one. */
  'brain:cancel': { args: [jobId: string]; result: BrainStatus }
  'brain:extraction': { args: [jobId: string]; result: BrainExtractionView }
  'brain:proposal': { args: [jobId: string]; result: BrainProposalView }
  /** `keep` lists proposal memory indexes to approve; null rejects the whole proposal. */
  'brain:review': {
    args: [jobId: string, keep: number[] | null, revision: number]
    result: BrainStatus
  }
  'brain:knowledge': { args: []; result: BrainKnowledge }
  'brain:memory': { args: [memoryId: string]; result: BrainMemoryDetail }
  /** Deletes one memory and any evidence no other memory cites. */
  'brain:forget': { args: [memoryId: string]; result: BrainStatus }
}
