import { useState } from 'react'
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
  return [selection.machine, (machine) => setSelection({ filter, machine })]
}
