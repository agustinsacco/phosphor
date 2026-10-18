/** One pending attachment inside a persisted draft. */
export interface DraftAttachment {
  kind: 'image' | 'file'
  name: string
  size: number
  /** kind 'file': the absolute path the agent is told to open. */
  path?: string
  /** kind 'image': file under `userData/drafts/`. */
  blobId?: string
  mimeType?: string
}

/** A composer's unsent state, durable across session switches and restarts. */
export interface ComposerDraftRecord {
  key: string
  text: string
  attachments: DraftAttachment[]
  /**
   * The model chosen for THIS draft. The home picker also writes pi's global
   * default, but coming back to a draft should restore the model you picked
   * for it rather than whatever the last session set globally.
   */
  model?: { provider: string; id: string }
  thinking?: string
  /** Swarm choice for an unsent new lane, not a preference for later lanes. */
  swarm?: boolean
  workspacePath?: string
  preferWorktree?: boolean
  updatedAt: number
}

/** Drafts kept per key; the oldest are pruned past this. */
export const MAX_DRAFTS = 30

/** Total bytes of draft image blobs allowed on disk. */
export const MAX_DRAFT_BLOB_BYTES = 50 * 1024 * 1024
