import type { SubscriptionProviderStatus } from '@shared/models'

// Each read runs one `pi auth check` per provider in main. Settings → Accounts
// reads on open and after every sign-in; the Machines page reuses its answer.
let last: SubscriptionProviderStatus[] | null = null

/** This Mac's subscription sign-ins, read now. */
export async function readLocalSubscriptionAuth(): Promise<SubscriptionProviderStatus[]> {
  last = await window.phosphor.invoke('pi:subscriptionAuth')
  return last
}

/** The last read of This Mac's subscription sign-ins, or a new one when there is none yet. */
export function lastLocalSubscriptionAuth(): Promise<SubscriptionProviderStatus[]> {
  return last ? Promise.resolve(last) : readLocalSubscriptionAuth()
}
