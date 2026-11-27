/** The connection token is an opaque transport incarnation, not an access grant. */
export interface BrainConnection {
  hostId: string
  connectionToken: string
}

export class StaleBrainScope extends Error {
  constructor() {
    super('The selected Brain changed. Refresh before trying again.')
  }
}

/**
 * Capture authority at click time, not after a confirmation, timer or await. A scope is
 * single-use even if the user comes back to the same Host and it still has the same IDs.
 */
export function createBrainScope(connection: BrainConnection, connected: () => boolean) {
  let attached = false
  let serial = 0
  let generation: string | null = null
  const attach = (): (() => void) => {
    attached = true
    return () => {
      attached = false
      serial++
    }
  }
  const capture = () => {
    const started = serial
    return () => attached && started === serial && connected()
  }
  async function run<T>(operation: (target: BrainConnection) => Promise<T>): Promise<T> {
    const current = capture()
    if (!current()) throw new StaleBrainScope()
    let result: T
    try {
      result = await operation(connection)
    } catch (error) {
      if (!current()) throw new StaleBrainScope()
      throw error
    }
    if (!current()) throw new StaleBrainScope()
    return result
  }
  return {
    attach,
    run,
    capture,
    invalidate: () => {
      serial++
    },
    /** A reset supersedes both outstanding replies and confirmations from the old store. */
    changeGeneration: (value: string) => {
      if (generation !== value) serial++
      generation = value
    },
  }
}
