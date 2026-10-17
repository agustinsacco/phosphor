import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TrafficEntry } from '@shared/ipc'
import { Button } from '@/components/form'
import { tooltipProps } from '@/components/Tooltip'
import { PaneIconButton } from '@/components/PaneShell'
import { CloseIcon } from '@/components/icons'
import { useMachinesStore } from '@/stores/machines'
import { StatusDot } from './MachineUi'

/** How often the open log asks main for new lines. */
export const TRAFFIC_POLL_MS = 500
/** Lines kept in this window; main keeps its own bounded window. */
export const TRAFFIC_VIEW_LIMIT = 1500
const HEARTBEATS = new Set(['ping', 'pong'])

/** Polls main's memory-only traffic log while `active`, resuming from the last line seen. */
export function useTrafficLog(active: boolean) {
  const [entries, setEntries] = useState<TrafficEntry[]>([])
  const [gap, setGap] = useState(false)
  const [failed, setFailed] = useState(false)
  const cursor = useRef(0)
  useEffect(() => {
    if (!active) return
    let live = true
    let inFlight = false
    async function tick(): Promise<void> {
      if (inFlight) return
      inFlight = true
      try {
        const page = await window.phosphor.invoke('hosts:traffic', cursor.current)
        if (!live) return
        setFailed(false)
        cursor.current = page.last
        if (page.gap) setGap(true)
        if (page.entries.length)
          setEntries((previous) => [...previous, ...page.entries].slice(-TRAFFIC_VIEW_LIMIT))
      } catch {
        if (live) setFailed(true)
      } finally {
        inFlight = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), TRAFFIC_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active])
  return {
    entries,
    gap,
    failed,
    clear: () => {
      setEntries([])
      setGap(false)
    },
  }
}

export function formatTrafficLine(entry: TrafficEntry, peer: string): string {
  const time = new Date(entry.at).toISOString().slice(11, 23)
  return [
    time,
    peer,
    entry.direction,
    entry.kind,
    entry.detail ?? '',
    entry.bytes !== undefined ? `${entry.bytes} B` : '',
    entry.ms !== undefined ? `${entry.ms} ms` : '',
    entry.code ?? entry.outcome ?? '',
  ].join('\t')
}

const ARROW: Record<TrafficEntry['direction'], string> = {
  out: '↑',
  in: '↓',
  call: '⇅',
  state: '•',
}
const ARROW_HINT: Record<TrafficEntry['direction'], string> = {
  out: 'Sent by this computer',
  in: 'Received by this computer',
  call: 'Request and reply',
  state: 'Connection state',
}

/** A live, metadata-only view of what this computer exchanges with control and its Hosts. */
export function TrafficLogPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [paused, setPaused] = useState(false)
  const { entries, gap, failed, clear } = useTrafficLog(!paused)
  const machines = useMachinesStore((s) => s.machines)
  const [peer, setPeer] = useState('all')
  const [heartbeats, setHeartbeats] = useState(false)
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState(false)
  const label = (entry: TrafficEntry): string =>
    entry.peer === 'control'
      ? 'control'
      : (machines.find((m) => m.id === entry.hostId)?.label ?? entry.hostId?.slice(0, 8) ?? 'host')
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter(
      (entry) =>
        (peer === 'all' ||
          (peer === 'control' ? entry.peer === 'control' : entry.hostId === peer)) &&
        (heartbeats || !HEARTBEATS.has(entry.kind)) &&
        (!errorsOnly || entry.outcome === 'error') &&
        (!needle ||
          `${entry.kind} ${entry.detail ?? ''} ${entry.code ?? ''}`.toLowerCase().includes(needle)),
    )
  }, [entries, peer, heartbeats, errorsOnly, query])
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const element = scroller.current
    if (element && pinned.current) element.scrollTop = element.scrollHeight
  }, [visible])
  const errors = entries.filter((e) => e.outcome === 'error').length
  return (
    <section
      aria-label="Debug log"
      data-testid="traffic-log"
      className="border-border bg-surface flex h-80 shrink-0 flex-col border-t"
    >
      <header className="border-border flex flex-wrap items-center gap-2 border-b px-3 py-1.5">
        <h2 className="text-text-tertiary font-mono text-xs font-semibold uppercase tracking-wider">
          Debug log
        </h2>
        <span role="status" className="text-text-secondary flex items-center gap-1.5 text-sm">
          <StatusDot tone={failed ? 'error' : paused ? 'off' : 'ok'} pulse={!paused && !failed} />
          {failed ? 'Not updating' : paused ? 'Paused' : 'Live'}
        </span>
        <span className="text-text-tertiary text-sm tabular-nums">
          {visible.length} of {entries.length}
          {errors ? ` · ${errors} ${errors === 1 ? 'error' : 'errors'}` : ''}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <select
            aria-label="Peer"
            value={peer}
            onChange={(event) => setPeer(event.target.value)}
            className="border-border bg-surface rounded-md border px-1.5 py-0.5 text-sm"
          >
            <option value="all">All traffic</option>
            <option value="control">Control plane</option>
            {machines.map((machine) => (
              <option key={machine.id} value={machine.id}>
                {machine.label}
              </option>
            ))}
          </select>
          <input
            aria-label="Filter"
            placeholder="Filter"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="border-border bg-surface w-28 rounded-md border px-1.5 py-0.5 text-sm"
          />
          <Toggle pressed={errorsOnly} onChange={setErrorsOnly}>
            Errors
          </Toggle>
          <Toggle pressed={heartbeats} onChange={setHeartbeats}>
            Pings
          </Toggle>
          <Button size="xs" onClick={() => setPaused((value) => !value)}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="xs" onClick={clear}>
            Clear
          </Button>
          <Button
            size="xs"
            onClick={() => {
              const text = visible.map((entry) => formatTrafficLine(entry, label(entry))).join('\n')
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1400)
              })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <PaneIconButton title="Close debug log" onClick={onClose}>
            <CloseIcon size={12} />
          </PaneIconButton>
        </div>
      </header>
      <div
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
        }}
        className="min-h-0 flex-1 overflow-y-auto font-mono text-sm"
      >
        {gap && (
          <p className="text-text-tertiary px-3 py-1">
            Older lines were dropped; showing the newest.
          </p>
        )}
        {visible.length === 0 ? (
          <p className="text-text-tertiary px-3 py-3 font-sans text-base">
            {entries.length
              ? 'No lines match these filters.'
              : 'Waiting for traffic. Lines appear as this computer talks to the control plane and its Hosts.'}
          </p>
        ) : (
          <table className="w-full border-collapse">
            <tbody>
              {visible.map((entry) => (
                <tr
                  key={entry.seq}
                  data-direction={entry.direction}
                  className={clsx(
                    'hover:bg-bg-secondary align-top',
                    entry.outcome === 'error' && 'bg-danger-soft/60',
                  )}
                >
                  <td className="text-text-tertiary whitespace-nowrap py-0.5 pl-3 pr-2 tabular-nums">
                    {new Date(entry.at).toLocaleTimeString(undefined, {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                      fractionalSecondDigits: 3,
                    })}
                  </td>
                  <td className="text-text-secondary max-w-28 truncate whitespace-nowrap pr-2">
                    {label(entry)}
                  </td>
                  <td
                    {...tooltipProps(ARROW_HINT[entry.direction])}
                    className={clsx(
                      'w-4 pr-2 text-center',
                      entry.direction === 'out'
                        ? 'text-accent'
                        : entry.direction === 'in'
                          ? 'text-info'
                          : 'text-text-tertiary',
                    )}
                  >
                    {ARROW[entry.direction]}
                  </td>
                  <td className="whitespace-nowrap pr-2 font-medium">{entry.kind}</td>
                  <td className="text-text-secondary w-full truncate pr-2">{entry.detail}</td>
                  <td className="text-text-tertiary whitespace-nowrap pr-2 text-right tabular-nums">
                    {entry.bytes !== undefined ? formatBytes(entry.bytes) : ''}
                  </td>
                  <td className="text-text-tertiary whitespace-nowrap pr-2 text-right tabular-nums">
                    {entry.ms !== undefined ? `${entry.ms} ms` : ''}
                  </td>
                  <td
                    className={clsx(
                      'whitespace-nowrap pr-3',
                      entry.outcome === 'error' ? 'text-danger' : 'text-success',
                    )}
                  >
                    {entry.code ?? (entry.outcome === 'ok' ? 'ok' : '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

function Toggle({
  pressed,
  onChange,
  children,
}: {
  pressed: boolean
  onChange: (value: boolean) => void
  children: string
}): React.JSX.Element {
  return (
    <Button
      size="xs"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={pressed ? 'bg-accent-soft text-text' : undefined}
    >
      {children}
    </Button>
  )
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
