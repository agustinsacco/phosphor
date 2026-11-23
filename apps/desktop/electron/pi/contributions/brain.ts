import {
  brainContribution,
  type BrainResources,
} from '@phosphor/session-runtime/pi/contributions/brain'

let resources: BrainResources | undefined
/** Installed after startup, so opening a lane needn't eagerly import Brain. */
export function setSessionRecall(value: BrainResources): void {
  resources = value
}

export function createBrainContribution() {
  return brainContribution(() => resources?.() ?? Promise.resolve(undefined))
}
