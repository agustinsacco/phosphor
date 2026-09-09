import { useEffect, useRef, useState } from 'react'
import { isNaming, isNamingInWorkspace, useNamingStore } from '@/stores/naming'

/**
 * How a session's title should be presented while its real name is decided.
 *
 * A chat now starts before it is named — the branch is cut from a slug of the
 * first message so pi can spawn immediately, and the generated title arrives
 * ~13s later. That leaves two moments worth showing rather than hiding:
 *
 * - `pending`: the title on screen is provisional. Shimmered, not skeletoned —
 *   it is real readable text, just not final. The top bar's title and both
 *   sidebar row types shimmer; the branch chip is the one consumer that only
 *   uses `pending` for its tooltip and leaves the motion alone, which keeps a
 *   single naming event from lighting up four animations at once. See
 *   `.name-pending` in index.css.
 * - `settled`: for one short beat after the real name lands, so the swap reads
 *   as an arrival instead of a glitch. The user is several seconds past having
 *   asked for anything by then, so this is deliberately brief and small.
 *
 * Shared by the sidebar row, the top bar and the branch chip so all three
 * describe the same moment the same way. Both hooks read `stores/naming.ts`
 * and nothing else — see the note there on why that store is separate.
 */

/** How long `settled` stays true. Matches `.name-enter` in index.css. */
const SETTLE_MS = 260

export interface NameTransition {
  pending: boolean
  settled: boolean
}

export function useNameTransition(phosphorId: string | undefined): NameTransition {
  return useSettleAfter(useNamingStore((s) => isNaming(s.naming, phosphorId)))
}

/**
 * Naming state for a *workspace* rather than a session — what the branch chip
 * needs, since it knows a folder and not which chat is running in it.
 *
 * Any chat in this folder still being named means the branch it is on may
 * still be renamed, so the chip is provisional too.
 */
export function useWorkspaceNameTransition(workspacePath: string): NameTransition {
  return useSettleAfter(useNamingStore((s) => isNamingInWorkspace(s.naming, workspacePath)))
}

/** `settled` is true for SETTLE_MS after `pending` goes true → false. */
function useSettleAfter(pending: boolean): NameTransition {
  const [settled, setSettled] = useState(false)
  const wasPending = useRef(pending)

  useEffect(() => {
    const justFinished = wasPending.current && !pending
    wasPending.current = pending
    if (!justFinished) return undefined
    setSettled(true)
    const timer = setTimeout(() => setSettled(false), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [pending])

  return { pending, settled }
}
