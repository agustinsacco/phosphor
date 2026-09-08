import { create } from 'zustand'

/**
 * Which sessions are still waiting on a generated name.
 *
 * A chat now starts before it is named — the branch is cut from a slug of the
 * first message so pi can spawn immediately, and the title arrives ~13s later
 * (docs/log/2026-08-22-fast-session-start.md). The title, the top bar and the
 * branch chip all show provisional values in the meantime, so they need to
 * know that.
 *
 * **Its own store on purpose.** This lived in `stores/sessions.ts` first, which
 * is the busiest store in the app: the sidebar, the top bar and the resource
 * monitor all subscribe to it, so every naming flip re-rendered all of them.
 * That is not merely wasteful — an unrelated re-render landing between a
 * native checkbox toggle and React's `onChange` commit reverts a controlled
 * input to its previous value, which is exactly how it was caught (the
 * resource monitor's "include terminals" toggle started failing in e2e, twice
 * in two runs, and passed with this state disabled).
 *
 * Keyed phosphorId → the workspace being named, rather than phosphorId → boolean, so
 * the branch chip can ask "is anything in my folder being named?" without also
 * subscribing to the live-session map it would otherwise need to join against.
 */
interface NamingState {
  /** phosphorId → workspacePath whose chat is currently being named. */
  naming: Record<string, string>
  start: (phosphorId: string, workspacePath: string) => void
  finish: (phosphorId: string) => void
}

export const useNamingStore = create<NamingState>((set) => ({
  naming: {},

  start: (phosphorId, workspacePath) =>
    set((s) => ({ naming: { ...s.naming, [phosphorId]: workspacePath } })),

  // Dropped rather than tombstoned: a session that has been named is not
  // "not naming", it is done, and this map is read per row on every render.
  finish: (phosphorId) =>
    set((s) => {
      if (!(phosphorId in s.naming)) return s
      const { [phosphorId]: _done, ...rest } = s.naming
      return { naming: rest }
    }),
}))

/** Is this session still waiting on its name? */
export function isNaming(naming: Record<string, string>, phosphorId: string | undefined): boolean {
  return phosphorId !== undefined && phosphorId in naming
}

/**
 * Is any chat in this folder still being named — i.e. might the branch the
 * folder is on still be renamed out from under the user?
 */
export function isNamingInWorkspace(
  naming: Record<string, string>,
  workspacePath: string,
): boolean {
  for (const path of Object.values(naming)) {
    if (path === workspacePath) return true
  }
  return false
}
