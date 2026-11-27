/** One open per key at a time, for in-app (`openDiskSession`) and Host (`openHostLane`) lanes. */
export interface OpenFlights<T> {
  has(key: string): boolean
  /**
   * Starts the key's open, or joins the one running. Each caller then lands
   * (activates) on its own terms with the shared result. The key is released
   * once the caller that started the open has landed, or when either fails,
   * so a repeat click while an open settles never starts a second one.
   */
  run<R>(key: string, start: () => Promise<T>, land: (result: T) => R | Promise<R>): Promise<R>
}

export function openFlights<T>(
  /** Told when a key starts flying and when it is released. */
  onFlight?: (key: string, flying: boolean) => void,
): OpenFlights<T> {
  const flights = new Map<string, Promise<T>>()
  return {
    has: (key) => flights.has(key),
    async run(key, start, land) {
      const joined = flights.get(key)
      const open = joined ?? start()
      if (!joined) {
        flights.set(key, open)
        onFlight?.(key, true)
      }
      try {
        return await land(await open)
      } finally {
        if (!joined) {
          flights.delete(key)
          onFlight?.(key, false)
        }
      }
    },
  }
}
