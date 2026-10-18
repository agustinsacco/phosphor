/** Per-Host admission shared by explicit account moves and credential removal. */
export function createAccountReservations(
  remove: (id: string, claudeOverride?: string) => Promise<void>,
) {
  const held = new Map<string, number>()
  const removing = new Set<string>()
  const busy = () => new Error('Claude account is in use. Wait for its account change to finish.')

  async function withAccount<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (removing.has(id)) throw busy()
    held.set(id, (held.get(id) ?? 0) + 1)
    try {
      return await run()
    } finally {
      const remaining = held.get(id)! - 1
      if (remaining) held.set(id, remaining)
      else held.delete(id)
    }
  }

  async function removeAccount(id: string, claudeOverride?: string): Promise<void> {
    if (held.has(id) || removing.has(id)) throw busy()
    // Claim synchronously, before the portable mutation queue or logout can await.
    removing.add(id)
    try {
      await remove(id, claudeOverride)
    } finally {
      removing.delete(id)
    }
  }

  return { withAccount, removeAccount }
}
