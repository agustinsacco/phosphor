import { useEffect, useEffectEvent, useRef } from 'react'
import { Button } from '@/components/form'
import { useSettingsUiStore } from '../settingsUiStore'

/** The scope line's Refresh, on every machine: reads the open section again. */
export function ScopeRefresh({
  onClick,
  disabled = false,
  label = 'Refresh',
}: {
  onClick: () => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <Button size="xs" className="ml-auto" disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  )
}

/** This Mac's Refresh: each of its sections reads again (`useOnLocalRefresh`). */
export function LocalRefresh(): React.JSX.Element {
  return <ScopeRefresh onClick={() => useSettingsUiStore.getState().reread()} />
}

/**
 * Runs a This Mac section's own read again on each scope-line Refresh after it
 * mounted; the section's first read stays its own.
 */
export function useOnLocalRefresh(read: () => unknown): void {
  const rereads = useSettingsUiStore((s) => s.rereads)
  const seen = useRef(rereads)
  const run = useEffectEvent(read)
  useEffect(() => {
    if (seen.current === rereads) return
    seen.current = rereads
    void run()
  }, [rereads])
}

/** A This Mac section's read: on mount, whenever `read` changes, and on each Refresh. */
export function useLocalRead(read: () => unknown): void {
  useEffect(() => {
    void read()
  }, [read])
  useOnLocalRefresh(read)
}
