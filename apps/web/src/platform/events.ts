export function createBrowserEvents() {
  const listeners = new Map<string, Set<(value: never) => void>>()
  return {
    on<T>(name: string, listener: (value: T) => void) {
      let set = listeners.get(name)
      if (!set) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(listener as (value: never) => void)
      return () => {
        set.delete(listener as (value: never) => void)
        if (!set.size) listeners.delete(name)
      }
    },
    emit<T>(name: string, value: T) {
      for (const listener of [...(listeners.get(name) ?? [])]) {
        try {
          listener(structuredClone(value) as never)
        } catch {
          /* One UI subscriber cannot block invalidation. */
        }
      }
    },
    clearSessions() {
      for (const name of listeners.keys()) if (name.startsWith('pi:event:')) listeners.delete(name)
    },
    clear() {
      listeners.clear()
    },
  }
}
