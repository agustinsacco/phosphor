import { useCallback, useState } from 'react'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/** A picker override lasts until the sidebar machine changes, never until restart. */
export function useComposerMachine(): [string, (machine: string) => void] {
  const filter = useRemoteLanesStore((s) => s.filter)
  const [selection, setSelection] = useState({
    filter,
    machine: filter === 'all' ? 'local' : filter,
  })
  if (selection.filter !== filter) {
    setSelection({ filter, machine: filter === 'all' ? 'local' : filter })
  }
  const setMachine = useCallback((machine: string) => setSelection({ filter, machine }), [filter])
  return [selection.machine, setMachine]
}
