/**
 * The popover's blocks: the summary strip, the graph, the cores, the memory,
 * Phosphor's own processes and the lanes.
 *
 * Each one says what it could not read. A Host sample carries nulls for the
 * reads the OS refused — the volume stat that timed out, the process census that
 * `ps` would not answer — and a dash that explains itself beats a zero, which
 * reads as an idle machine and an empty disk.
 */
import { TooltipButton } from '@/components/Tooltip'
import { formatBytes } from '@/lib/format'
import clsx from 'clsx'
import {
  RANGES,
  UNREADABLE,
  brailleBars,
  formatBytesOr,
  formatPct,
  type RangeId,
} from './telemetryReadout'
import type { HostLaneView } from '@shared/ipc'
import type { LaneActivity } from '@shared/host-protocol'
import type { TelemetryPoint, TelemetryView } from '@/stores/telemetryModel'

/** The graph's width in characters. Narrower than the popover so it never wraps. */
const GRAPH_COLUMNS = 44
/** Per-core bars stay legible as a grid; past this the count is the number instead. */
const CORE_BARS_SHOWN = 32

/** The four numbers that answer "is anything wrong", before any detail. */
export function Summary({
  view,
  lanes,
}: {
  view: TelemetryView
  lanes: readonly HostLaneView[]
}): React.JSX.Element {
  const active = lanes.filter((lane) => lane.activity !== 'stopped').length
  return (
    <div className="grid grid-cols-4">
      <Stat label="cpu" value={formatPct(view.cpu)} pct={view.cpu} />
      <Stat label="memory" value={formatPct(view.memPct)} pct={view.memPct} />
      <Stat label="phosphor" value={formatBytesOr(view.phosphorRss)} />
      <Stat label="lanes" value={view.current ? String(active) : UNREADABLE} />
    </div>
  )
}

function Stat({
  label,
  value,
  pct,
}: {
  label: string
  value: string
  pct?: number | null
}): React.JSX.Element {
  return (
    <div className="border-border min-w-0 border-l px-3 py-2 first:border-l-0">
      <div className="text-text-tertiary font-mono text-2xs uppercase tracking-wider">{label}</div>
      <div className="text-text font-mono text-base font-semibold leading-tight tabular-nums">
        {value}
      </div>
      {pct !== undefined && <Bar pct={pct} />}
    </div>
  )
}

function Bar({ pct }: { pct: number | null }): React.JSX.Element {
  return (
    <span className="bg-bg-secondary mt-1 block h-0.5 overflow-hidden rounded-md">
      {pct !== null && (
        <span
          className={clsx(
            'block h-full',
            pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : 'bg-accent',
          )}
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` } as React.CSSProperties}
        />
      )}
    </span>
  )
}

/** The last window of samples, and the only control in the popover. */
export function Graph({
  window,
  range,
  onRange,
}: {
  window: readonly TelemetryPoint[]
  range: RangeId
  onRange: (range: RangeId) => void
}): React.JSX.Element {
  return (
    <section className="border-border border-t px-3 py-2">
      <div className="mb-1 flex items-center justify-between">
        <Heading>load</Heading>
        <div className="flex items-center gap-0.5">
          {RANGES.map((option) => (
            <TooltipButton
              key={option.id}
              onClick={() => onRange(option.id)}
              tooltip={false}
              aria-pressed={option.id === range}
              className={clsx(
                'rounded-md px-1.5 py-0.5 font-mono text-2xs transition-colors',
                option.id === range
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-tertiary hover:bg-bg-secondary',
              )}
            >
              {option.label}
            </TooltipButton>
          ))}
        </div>
      </div>
      <Series
        label="cpu"
        line={brailleBars(
          window.map((point) => point.cpu ?? 0),
          GRAPH_COLUMNS,
        )}
        className="text-accent"
      />
      <Series
        label="mem"
        line={brailleBars(
          window.map((point) => point.memPct),
          GRAPH_COLUMNS,
        )}
        className="text-text-secondary"
      />
    </section>
  )
}

function Series({
  label,
  line,
  className,
}: {
  label: string
  line: string
  className: string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-text-tertiary w-8 shrink-0 font-mono text-2xs">{label}</span>
      <span
        className={clsx('telemetry-graph font-mono text-sm leading-none', className)}
        aria-label={`${label} over the last window`}
      >
        {line || UNREADABLE}
      </span>
    </div>
  )
}

/** One thin bar per core: the shape of the load, not a table of 64 numbers. */
export function Cores({ corePct }: { corePct: readonly number[] | null }): React.JSX.Element {
  const shown = corePct ? corePct.slice(0, CORE_BARS_SHOWN) : null
  return (
    <section className="border-border border-t px-3 py-2">
      <Heading>
        cores{corePct ? ` · ${corePct.length}` : ''}
        {corePct && corePct.length > CORE_BARS_SHOWN ? ` (first ${CORE_BARS_SHOWN})` : ''}
      </Heading>
      {shown === null ? (
        <Quiet>needs one more sample to measure</Quiet>
      ) : shown.length === 0 ? (
        <Quiet>could not be read</Quiet>
      ) : (
        <div className="telemetry-cores mt-1.5">
          {shown.map((pct, index) => (
            <span
              key={index}
              data-tooltip={`core ${index}: ${formatPct(pct)}`}
              className="telemetry-core"
              style={
                {
                  '--fill': `${Math.min(100, Math.max(3, pct))}%`,
                  '--fill-color': fillColour(pct),
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function Memory({ view }: { view: TelemetryView }): React.JSX.Element {
  const mem = view.current?.mem
  const disk = view.current?.disk
  return (
    <section className="border-border border-t px-3 py-2">
      <Heading>memory</Heading>
      <Rows
        rows={[
          ['used', mem ? `${formatBytes(mem.used)} of ${formatBytes(mem.total)}` : UNREADABLE],
          ['cache', mem && mem.cache > 0 ? formatBytes(mem.cache) : UNREADABLE],
          [
            'swap',
            !mem
              ? UNREADABLE
              : mem.swapTotal > 0
                ? `${formatBytes(mem.swapUsed)} of ${formatBytes(mem.swapTotal)}`
                : 'none',
          ],
          [
            'disk',
            disk
              ? `${formatBytes(disk.free)} free of ${formatBytes(disk.total)}`
              : view.current
                ? 'could not be read'
                : UNREADABLE,
          ],
        ]}
      />
    </section>
  )
}

/** Phosphor's own processes by what they are: the answer to "what is it using". */
export function Phosphor({ view }: { view: TelemetryView }): React.JSX.Element {
  const census = view.current?.census ?? null
  return (
    <section className="border-border border-t px-3 py-2">
      <Heading>
        phosphor
        {census ? ` · ${formatBytesOr(view.phosphorRss)} · ${view.phosphorProcs ?? 0} procs` : ''}
      </Heading>
      {census === null ? (
        <Quiet>{view.current ? 'could not be read' : 'no sample yet'}</Quiet>
      ) : census.kinds.length === 0 ? (
        <Quiet>nothing of ours running</Quiet>
      ) : (
        <Rows
          rows={census.kinds.map((kind) => [
            kind.kind,
            [
              String(kind.procs),
              formatBytes(kind.rss),
              view.procPct[kind.kind] === undefined
                ? null
                : `${formatPct(view.procPct[kind.kind] ?? 0)} cpu`,
            ]
              .filter((part): part is string => part !== null)
              .join(' · '),
          ])}
        />
      )}
    </section>
  )
}

/** Lane states, in the order a person can act on them. */
export function Lanes({ lanes }: { lanes: readonly HostLaneView[] }): React.JSX.Element {
  const counts = countByActivity(lanes)
  const parts: readonly (readonly [string, LaneActivity, number])[] = [
    ['working', 'working', counts.working],
    ['needs input', 'needs-input', counts['needs-input']],
    ['idle', 'idle', counts.idle],
    ['failed', 'failed', counts.failed],
    ['stopped', 'stopped', counts.stopped],
  ]
  return (
    <section className="border-border border-t px-3 py-2">
      <Heading>lanes</Heading>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-2xs">
        {parts
          .filter(([, , count]) => count > 0)
          .map(([label, activity, count]) => (
            <span
              key={label}
              className={
                activity === 'needs-input' || activity === 'failed'
                  ? 'text-warning'
                  : 'text-text-secondary'
              }
            >
              {count} {label}
            </span>
          ))}
        {parts.every(([, , count]) => count === 0) && (
          <QuietLabel>no lanes on this machine</QuietLabel>
        )}
      </div>
    </section>
  )
}

function Rows({ rows }: { rows: readonly (readonly [string, string])[] }): React.JSX.Element {
  return (
    <dl className="mt-1 space-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-3">
          <dt className="text-text-tertiary w-16 shrink-0 font-mono text-2xs">{label}</dt>
          <dd className="text-text-secondary min-w-0 flex-1 truncate font-mono text-2xs">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="text-text-tertiary font-mono text-2xs uppercase tracking-wider">{children}</h3>
  )
}

function Quiet({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-text-tertiary mt-1 font-mono text-2xs">{children}</p>
}

function QuietLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-text-tertiary">{children}</span>
}

/** A core worth noticing is coloured like everything else that needs noticing. */
function fillColour(pct: number): string | undefined {
  return pct >= 90 ? 'var(--px-danger)' : pct >= 75 ? 'var(--px-warning)' : undefined
}

/** Lane counts by activity. `needs-input` is its own row; nothing is merged. */
function countByActivity(lanes: readonly HostLaneView[]): Record<LaneActivity, number> {
  const counts: Record<LaneActivity, number> = {
    stopped: 0,
    idle: 0,
    working: 0,
    'needs-input': 0,
    failed: 0,
  }
  for (const lane of lanes) counts[lane.activity]++
  return counts
}
