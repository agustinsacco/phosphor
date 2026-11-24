/**
 * Public measurement knobs, shared by query, expansion and Find. Set from the recall measurement:
 * meaning leads, and naming a person or thing counts for less, because a hub named in dozens of
 * memories says little about which one answers.
 */
export const RECALL_TUNING = {
  semantic: 4,
  lexical: 1,
  exact: 0.5,
  linked: 0.5,
  alpha: 0.3,
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
