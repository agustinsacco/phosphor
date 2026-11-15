import { useEffect } from 'react'
import { create } from 'zustand'
import { useFind, type FindState } from '@/components/search/useFind'
import { useFindTarget } from '@/components/search/findTargets'

/** Menu requests survive switching from another pane until this transcript mounts. */
export const useChatFindRequest = create<{ sessionId: string | null }>(() => ({ sessionId: null }))
export const requestChatFind = (sessionId: string): void =>
  useChatFindRequest.setState({ sessionId })

export function useChatFind(
  sessionId: string,
  containerRef: React.RefObject<HTMLElement | null>,
): FindState {
  const find = useFind()
  const { show } = find
  useFindTarget(containerRef, show, true)
  const requested = useChatFindRequest((s) => s.sessionId === sessionId)
  useEffect(() => {
    if (!requested) return
    useChatFindRequest.setState({ sessionId: null })
    show()
  }, [requested, show])
  return find
}
