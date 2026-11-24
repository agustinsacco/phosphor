/** Public measurement knobs, shared by query, expansion and Find. */
export const RECALL_TUNING = {
  semantic: 2,
  lexical: 1,
  exact: 1,
  linked: 1,
  alpha: 0.15,
  iterations: 20,
  important: 1.1,
  unimportant: 0.9,
  expired: 0.5,
  scope: 1.25,
  freshness: 0.05,
  focusSeed: 1,
  candidateSeed: 0.5,
  entityVectorSeed: 0.5,
  lexicalSeed: 0.5,
  structural: 1,
  relation: 0.6,
  minCosine: 0.35,
  rrf: 60,
}
export type RecallTuning = typeof RECALL_TUNING
