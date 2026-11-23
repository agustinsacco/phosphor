import {
  brainContribution,
  type BrainResources,
} from '@phosphor/session-runtime/pi/contributions/brain'

/** D9 installs the lookup; each spawn checks the current registration and recall preference. */
let resources: BrainResources | undefined
export function setHostBrainRecall(value: BrainResources | undefined): void {
  resources = value
}

export function createBrainContribution() {
  return brainContribution(() => resources?.() ?? Promise.resolve(undefined))
}
