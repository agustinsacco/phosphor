/** Guards only routine-owned sessions. It is not a second process registry. */
const owned = new Map<string, string | null>()
const observed = new Set<string>()
export function observeRoutineSession(id: string): void {
  if (owned.has(id)) observed.add(id)
}
export function routineSessionObserved(id: string): boolean {
  return observed.has(id)
}
export function ownRoutineSession(id: string, path: string | null = null): void {
  owned.set(id, path)
}
export function releaseRoutineSession(id: string): void {
  owned.delete(id)
  observed.delete(id)
}
export function isRoutineSession(id: string): boolean {
  return owned.has(id)
}
export function routineSessionForPath(path: string): string | undefined {
  return [...owned].find(([, file]) => file === path)?.[0]
}
