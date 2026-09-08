import { useRef, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import type { QueueMode } from '@shared/rpc'
import { piCallOk } from '@/lib/rpc'
import { exportSessionHtml } from '@/features/sessions/sessionActions'
import { promptText } from '@/stores/prompt'

/**
 * Auto-retry state isn't reported by get_state, so Phosphor tracks the last
 * value it set per session (pi defaults to enabled).
 */
const autoRetryLocal = new Map<string, boolean>()

/** Kebab menu in the session header: compaction, retry, queue modes, export. */
export function SessionMenu({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [autoRetry, setAutoRetryState] = useState(autoRetryLocal.get(sessionId) ?? true)
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta)

  const toggleAutoRetry = async (): Promise<void> => {
    if (!(await piCallOk(sessionId, { type: 'set_auto_retry', enabled: !autoRetry }))) return
    autoRetryLocal.set(sessionId, !autoRetry)
    setAutoRetryState(!autoRetry)
  }

  const command = async (run: () => Promise<unknown>): Promise<void> => {
    setOpen(false)
    await run()
  }

  const toggleAutoCompaction = async (): Promise<void> => {
    const enabled = !(meta?.autoCompactionEnabled ?? true)
    if (!(await piCallOk(sessionId, { type: 'set_auto_compaction', enabled }))) return
    useChatStore.getState().patchMeta(sessionId, { autoCompactionEnabled: enabled })
  }

  const setSteeringMode = async (mode: QueueMode): Promise<void> => {
    if (!(await piCallOk(sessionId, { type: 'set_steering_mode', mode }))) return
    useChatStore.getState().patchMeta(sessionId, { steeringMode: mode })
  }

  const setFollowUpMode = async (mode: QueueMode): Promise<void> => {
    if (!(await piCallOk(sessionId, { type: 'set_follow_up_mode', mode }))) return
    useChatStore.getState().patchMeta(sessionId, { followUpMode: mode })
  }

  const compactNow = async (): Promise<void> => {
    const instructions = await promptText({
      title: 'Compact context now',
      message: 'Optional: custom instructions for the compaction summary (leave blank for default)',
      allowEmpty: true,
    })
    if (instructions === undefined) return
    await piCallOk(sessionId, {
      type: 'compact',
      ...(instructions ? { customInstructions: instructions } : {}),
    })
  }

  const exportHtml = (): Promise<void> =>
    exportSessionHtml(sessionId, meta?.sessionName ?? 'session')

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        title="Session options"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>

      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute right-0 top-full mt-1.5 w-60 max-w-[calc(100vw-16rem)] py-1"
        >
          <MenuRow active={false} onClick={() => void command(exportHtml)}>
            <span className="flex-1">Export HTML…</span>
          </MenuRow>
          <MenuRow active={false} onClick={() => void command(compactNow)}>
            <span className="flex-1">Compact now…</span>
          </MenuRow>
          <Separator />
          {/* Toggles and cycles keep the menu open: they are settings you may
              want to flip two of, not commands that take you elsewhere. */}
          <MenuRow active={false} onClick={() => void toggleAutoCompaction()}>
            <span className="flex-1">Auto-compaction</span>
            <ToggleDot on={meta?.autoCompactionEnabled ?? true} />
          </MenuRow>
          <MenuRow
            active={false}
            onClick={() => void toggleAutoRetry()}
            title="Retry the turn automatically after a transient provider error"
          >
            <span className="flex-1">Auto-retry</span>
            <ToggleDot on={autoRetry} />
          </MenuRow>
          <Separator />
          {/* One row per queue, cycling its two modes in place. Two labelled
              sections of two radio rows each said the same thing in six. */}
          <ModeRow
            label="Steering"
            title="How messages you send WHILE the agent is working are delivered"
            mode={meta?.steeringMode ?? 'all'}
            onCycle={(mode) => void setSteeringMode(mode)}
          />
          <ModeRow
            label="Follow-ups"
            title="How messages queued for AFTER the turn are delivered"
            mode={meta?.followUpMode ?? 'all'}
            onCycle={(mode) => void setFollowUpMode(mode)}
          />
        </PopupMenu>
      )}
    </div>
  )
}

function Separator(): React.JSX.Element {
  return <div className="border-border my-1 border-t" />
}

const QUEUE_MODE_LABEL: Record<QueueMode, string> = {
  all: 'All at once',
  'one-at-a-time': 'One at a time',
}

/** Label plus the mode it is currently in; clicking steps to the other one. */
function ModeRow({
  label,
  title,
  mode,
  onCycle,
}: {
  label: string
  title: string
  mode: QueueMode
  onCycle: (mode: QueueMode) => void
}): React.JSX.Element {
  const next: QueueMode = mode === 'all' ? 'one-at-a-time' : 'all'
  return (
    <MenuRow active={false} title={title} onClick={() => onCycle(next)}>
      <span className="flex-1">{label}</span>
      <span className="text-text-tertiary text-base">{QUEUE_MODE_LABEL[mode]}</span>
    </MenuRow>
  )
}

function ToggleDot({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span
      className={`relative h-4 w-7 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-border-strong'}`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${on ? 'left-3.5' : 'left-0.5'}`}
      />
    </span>
  )
}
