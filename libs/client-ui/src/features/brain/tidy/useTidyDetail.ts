import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { useBrain } from '../useBrain'

export type TidyDetailRead =
  { ok: true; value: BrainTidySuggestionDetail | null } | { ok: false; error: string }

/** A null answer is a removed suggestion, not a loading state or a transport failure. */
export function useTidyDetail(id: string) {
  const revision = useBrain((s) => s.status?.revision)
  const generation = useBrain((s) => s.status?.generation)
  const [state, setState] = useState<{
    data: BrainTidySuggestionDetail | null
    loaded: boolean
    error: string
  }>({ data: null, loaded: false, error: '' })
  const request = useRef(0)
  const invalidate = useCallback(() => {
    request.current++
  }, [])
  const reload = useCallback(async (): Promise<TidyDetailRead> => {
    const ticket = ++request.current
    setState({ data: null, loaded: false, error: '' })
    if (!id) return { ok: false, error: '' }
    try {
      const value = await window.phosphor.invoke('brain:tidySuggestion', id)
      if (request.current !== ticket) return { ok: false, error: '' }
      setState({ data: value, loaded: true, error: '' })
      return { ok: true, value }
    } catch (cause) {
      const error = ipcErrorText(cause)
      if (request.current === ticket) setState({ data: null, loaded: false, error })
      return { ok: false, error }
    }
  }, [id])
  useEffect(() => {
    void reload()
    return invalidate
  }, [reload, invalidate, revision, generation])
  return {
    ...state,
    reload,
    retry: () => {
      void reload()
    },
  }
}
