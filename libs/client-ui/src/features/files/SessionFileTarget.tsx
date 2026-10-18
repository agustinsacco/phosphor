import { createContext, useContext } from 'react'
/** A model-authored path belongs to the transcript that rendered it, not global focus. */
export const SessionFileTarget = createContext<string | null>(null)
export const useSessionFileTarget = (): string | null => useContext(SessionFileTarget)
