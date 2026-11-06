/** Brain v1: machine-local, opt-in, reviewed memory. No credentials or database paths. */
export const BRAIN_PROTOCOL = 1
export const BRAIN_PREDICATES = [
  'owns',
  'depends_on',
  'blocks',
  'affects',
  'decided',
  'about',
] as const
export type BrainPredicate = (typeof BRAIN_PREDICATES)[number]
export type BrainEntityKind =
  'person' | 'team' | 'project' | 'customer' | 'component' | 'incident' | 'contract' | 'concept'
export type BrainEpistemicKind = 'observed' | 'reported' | 'inferred'
export interface BrainModel {
  provider: string
  id: string
}
export interface BrainPrefs {
  enabled: boolean
  recall: boolean
  /** Explicitly enrolled canonical workspaces; new evidence only by default. */
  workspaces: string[]
  processor: BrainModel | null
  retentionDays: number
}
export const DEFAULT_BRAIN_PREFS: BrainPrefs = {
  enabled: false,
  recall: false,
  workspaces: [],
  processor: null,
  retentionDays: 30,
}
export interface BrainRevision {
  graphRevision: number
  policyEpoch: number
}
export interface BrainEvidence {
  id: string
  scope: string
  sessionId: string
  entryId: string
  parentId: string | null
  /** Original independent roots, not the number of copies or summaries. */
  rootIds: string[]
  branch: string | null
  role: 'user' | 'toolResult' | 'assistant'
  label: string
  observedAt: number
  text: string
  hash: string
}
export type BrainCapture = Omit<BrainEvidence, 'id' | 'hash'>
export interface BrainEntity {
  id: string
  scope: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
}
export interface BrainCitation {
  evidenceId: string
  quote: string
}
export interface BrainClaim {
  id: string
  scope: string
  subjectId: string
  predicate: BrainPredicate
  objectId: string | null
  literal: string | null
  summary: string
  kind: BrainEpistemicKind
  state: 'active' | 'contested' | 'superseded'
  citations: BrainCitation[]
  conflictIds: string[]
  validFrom: number | null
  validTo: number | null
  recordedAt: number
  retractedAt: number | null
  revision: number
}
export interface BrainEntityProposal {
  key: string
  existingId?: string
  label: string
  kind: BrainEntityKind
  aliases: string[]
  evidenceIds: string[]
}
export interface BrainClaimProposal {
  subject: string
  predicate: BrainPredicate
  object?: string
  literal?: string
  summary: string
  kind: BrainEpistemicKind
  citations: BrainCitation[]
  validFrom: number | null
  validTo: number | null
  supersedes?: string
}
export interface BrainProposalInput {
  entities: BrainEntityProposal[]
  claims: BrainClaimProposal[]
  rationale: string
}
export interface BrainProposal extends BrainRevision {
  id: string
  jobId: string
  scope: string
  createdAt: number
  state: 'pending' | 'applied' | 'rejected'
  input: BrainProposalInput
}
export interface BrainJob extends BrainRevision {
  id: string
  scope: string
  evidenceIds: string[]
  model: BrainModel
  state: 'queued' | 'running' | 'proposed' | 'failed' | 'cancelled' | 'interrupted'
  fence: number
  createdAt: number
  updatedAt: number
  sessionPath: string | null
  error: string | null
}
export interface BrainSnapshot extends BrainRevision {
  prefs: BrainPrefs
  entities: BrainEntity[]
  claims: BrainClaim[]
  proposals: BrainProposal[]
  jobs: BrainJob[]
  evidence: Pick<BrainEvidence, 'id' | 'scope' | 'label' | 'role' | 'observedAt'>[]
  counts: { evidence: number; claims: number; entities: number; vectors: number }
  truncated: boolean
}
export interface BrainEmbeddingStatus {
  phase:
    'off' | 'missing' | 'downloading' | 'verifying' | 'testing' | 'ready' | 'error' | 'unsupported'
  receivedBytes: number
  totalBytes: number
  error?: string
  modelId: string
  dimensions: number
}
export interface BrainStatus {
  supported: boolean
  snapshot: BrainSnapshot
  embedding: BrainEmbeddingStatus
  /** Explicitly separate local embeddings from reasoning-provider disclosure. */
  notice: string
}
export interface BrainQuery {
  query: string
  entityIds?: string[]
  scopes?: string[]
  validAt?: number
  knownAt?: number
  limit?: number
  tokenBudget?: number
  mode?: 'lexical' | 'hybrid'
}
export interface BrainSearchHit {
  claim: BrainClaim
  evidence: BrainEvidence[]
  reasons: ('exact' | 'lexical' | 'semantic' | 'relationship')[]
  score: number
}
export interface BrainSearchResult extends BrainRevision {
  status: 'ok' | 'no_match' | 'partial' | 'unavailable' | 'needs_disambiguation'
  results: BrainSearchHit[]
  entities: BrainEntity[]
  degradation: string[]
  truncated: boolean
}
/** Replacing a claim is an explicit human edit, not a model's direct write. */
export type BrainCorrection = Pick<
  BrainClaim,
  'subjectId' | 'predicate' | 'objectId' | 'literal' | 'summary' | 'validFrom' | 'validTo'
> & { reason: string }
export interface BrainGraph {
  nodes: BrainEntity[]
  edges: BrainClaim[]
  truncated: boolean
}
export interface BrainForgetResult {
  evidence: number
  claims: number
  affectedSessions: string[]
}
export interface BrainDelivery {
  sessionId: string
  evidenceIds: string[]
  claimIds: string[]
}
/** UI commands. Authority comes from the Desktop handler, never this DTO. */
export interface BrainInvokeMap {
  'brain:status': { args: []; result: BrainStatus }
  'brain:setPrefs': { args: [prefs: BrainPrefs]; result: BrainStatus }
  'brain:download': { args: [acceptTerms: boolean]; result: BrainStatus }
  'brain:removeModel': { args: []; result: BrainStatus }
  'brain:search': { args: [query: BrainQuery]; result: BrainSearchResult }
  'brain:read': { args: [evidenceId: string]; result: BrainEvidence }
  'brain:graph': { args: [entityId?: string]; result: BrainGraph }
  'brain:process': { args: [scope: string]; result: BrainJob }
  'brain:cancel': { args: [jobId: string]; result: void }
  'brain:review': {
    args: [proposalId: string, approve: boolean, revision: BrainRevision]
    result: void
  }
  'brain:correct': {
    args: [claimId: string, correction: BrainCorrection, revision: BrainRevision]
    result: void
  }
  'brain:forget': { args: [evidenceIds: string[]]; result: BrainForgetResult }
  'brain:transcript': { args: [jobId: string]; result: string }
}
/** Agent transport is separate from UI review/settings permissions. */
export interface BrainAgentMap {
  search: { request: BrainQuery; result: BrainSearchResult }
  read: { request: { evidenceId: string }; result: BrainEvidence }
  brief: { request: { query: string }; result: BrainSearchResult }
  job: { request: Record<string, never>; result: { job: BrainJob; evidence: BrainEvidence[] } }
  propose: { request: { input: BrainProposalInput }; result: { proposalId: string } }
}
export type BrainAgentMethod = keyof BrainAgentMap
export interface BrainAgentRequest {
  version: 1
  token: string
  method: BrainAgentMethod
  params: unknown
}
export type BrainAgentResponse = { ok: true; data: unknown } | { ok: false; error: string }
