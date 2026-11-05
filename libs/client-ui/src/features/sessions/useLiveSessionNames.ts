import { useMemo } from 'react'
import { useChatStore } from '@/stores/chat'

/**
 * Live session names while a lane search is applied, for This Mac's groups and
 * Host folders alike. pi's name leads the disk scan and the Host summary by
 * their debounce, so without it a lane renamed a moment ago is not findable
 * under the name its row shows. `keyOf` names a session's entry (its own id,
 * or a Host lane's id); a session it maps to nothing is left out.
 *
 * Subscribed as a joined STRING so streaming re-renders nothing: the chat
 * store replaces `sessions` on every token, but this value only changes when
 * a name does. The map is rebuilt off that key, and the whole thing costs
 * nothing while no search is applied.
 */
export function useLiveSessionNames(
  active: boolean,
  keyOf: (sessionId: string) => string | undefined = (sessionId) => sessionId,
): Map<string, string> {
  const joined = useChatStore((s) =>
    active
      ? Object.entries(s.sessions)
          .flatMap(([sessionId, session]) => {
            const key = keyOf(sessionId)
            const name = session.meta?.sessionName
            return key && name ? [`${key}\u0000${name}`] : []
          })
          .join('\u0001')
      : '',
  )
  return useMemo(
    () =>
      new Map(
        joined
          ? joined.split('\u0001').map((entry) => entry.split('\u0000') as [string, string])
          : [],
      ),
    [joined],
  )
}
