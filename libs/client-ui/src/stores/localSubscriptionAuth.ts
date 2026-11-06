import type { SubscriptionProviderStatus } from '@shared/models'

// Each read runs one `pi auth check` per provider in main. Settings → Accounts
// reads on open and after every sign-in, the health check on every run and the
// model catalogue on every refresh; the Machines page reuses the answer, or the
// read still in flight.
let last: Promise<SubscriptionProviderStatus[]> | null = null

/** This Mac's subscription sign-ins, read now. A failed read keeps the last answer. */
export function readLocalSubscriptionAuth(): Promise<SubscriptionProviderStatus[]> {
  const previous = last
  const read = window.phosphor.invoke('pi:subscriptionAuth')
  last = read
  read.catch(() => {
    if (last === read) last = previous
  })
  return read
}

/** The last read of This Mac's subscription sign-ins, or a new one when there is none yet. */
export function lastLocalSubscriptionAuth(): Promise<SubscriptionProviderStatus[]> {
  return last ?? readLocalSubscriptionAuth()
}
