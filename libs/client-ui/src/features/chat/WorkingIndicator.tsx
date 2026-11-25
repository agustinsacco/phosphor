import { tooltipProps } from '@/components/Tooltip'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { formatDuration, formatRate, formatTokens } from '@/lib/format'
import { buildTranscriptRows, trailingUnfinishedAgents } from './items/transcriptRows'
import {
  genRateFrom,
  recordGenSample,
  resetGenSamples,
  type GenRate,
  type GenSample,
} from './genRate'

/**
 * Persistent "pi is working" strip: elapsed time and running token count for
 * whole agent operation (not per turn — `agentStartedAt` is set once on
 * `agent_start` and only cleared on `agent_settled`, so tool runs, retries,
 * and queued continuations keep one continuous timer).
 *
 * Tokens read `stats.tokens.total`, refreshed live on every `message_end` /
 * `tool_execution_end` (see shouldRefreshStatsOn in stores/sessions.ts) — it
 * climbs during the run rather than jumping once at the end.
 *
 * The `tok/s` figure is the model's throughput over the last stretch of
 * streaming (genRate.ts) and drops out while pi is running a tool, so the
 * number never describes a wait as a slow model.
 */
/**
 * "These sub-agents never reported back" strip for the Claude provider.
 *
 * Shown when the LAST turn left Claude Code sub-agents unfinished and the
 * user has not replied yet.
 *
 * This used to fire on every launch, because every launch was a dead end:
 * the provider killed `claude -p` at the turn's first `result`, which for a
 * background `Agent` call lands while the agents are still working. In the
 * original capture (`~/.claude/projects/…/01a0271c-….jsonl`) the CLI's record
 * simply ends after the launch — no notification, no results, never resumed.
 *
 * `pi-claude-cli` 0.4.14 fixed that: a `result` with agents pending is a
 * cycle boundary, the CLI re-invokes the model itself when they report, and
 * their findings land in the same turn. So the strip is now driven by
 * EVIDENCE — agents whose markers never reached a terminal state — instead of
 * by the assumption. Phosphor pins no provider version, so both shapes will keep
 * arriving from real sessions; counting what the transcript proves is the
 * only version-free way to be right about either.
 */
export function AgentLaunchStrip({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const items = useChatStore((s) => s.sessions[sessionId]?.items)
  const isStreaming = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const count = useMemo(
    () => (items ? trailingUnfinishedAgents(buildTranscriptRows(items)) : 0),
    [items],
  )
  if (isStreaming || count === 0) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="agent-launch-strip">
      <div
        className="text-text-secondary flex items-center gap-2 px-2 text-base"
        {...tooltipProps({
          label: 'Sub-agents never reported back',
          description: 'Update pi-claude-cli to 0.4.14+ so background agents can finish',
        })}
      >
        {/* bg-bg-secondary, not a *-soft token: only accent-soft and
            danger-soft are defined, and this is a caution, not an error. */}
        <span className="bg-bg-secondary text-warning rounded px-1.5 py-px text-xs font-semibold uppercase tracking-wide">
          agent
        </span>
        <span>
          {count === 1 ? 'A sub-agent' : `${count} sub-agents`} never reported back — ask again to
          get the work done here
        </span>
      </div>
    </div>
  )
}

export function WorkingIndicator({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const isStreaming = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const agentStartedAt = useChatStore((s) => s.sessions[sessionId]?.agentStartedAt ?? null)
  const totalTokens = useChatStore((s) => s.sessions[sessionId]?.stats?.tokens.total)
  const outputTokens = useChatStore((s) => s.sessions[sessionId]?.stats?.tokens.output)
  const [elapsedMs, setElapsedMs] = useState(0)
  const speed = useGenRate(agentStartedAt, outputTokens)

  useEffect(() => {
    if (!agentStartedAt) return
    setElapsedMs(Date.now() - agentStartedAt)
    const interval = setInterval(() => setElapsedMs(Date.now() - agentStartedAt), 1000)
    return () => clearInterval(interval)
  }, [agentStartedAt])

  if (!isStreaming || !agentStartedAt) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="working-indicator">
      <div className="text-text-secondary flex items-center gap-2 px-2 text-base">
        <PhosphorLoader decorative />
        <span className="text-text font-medium">Working</span>
        <span className="tabular-nums">{formatDuration(elapsedMs)}</span>
        {totalTokens != null && (
          <>
            <span className="text-text-tertiary">·</span>
            <span className="tabular-nums">{formatTokens(totalTokens)} tokens</span>
          </>
        )}
        {speed && (
          <>
            <span className="text-text-tertiary">·</span>
            <span
              className="tabular-nums"
              data-testid="working-speed"
              {...tooltipProps({
                label: `${formatRate(speed.tokensPerSecond)} tokens per second`,
                description:
                  `${formatTokens(speed.tokens)} generated over the last ` +
                  `${Math.round(speed.spanMs / 1000)}s. Tool calls and waits are left out, ` +
                  'so the figure disappears while pi is not generating.',
              })}
            >
              {formatRate(speed.tokensPerSecond)} tok/s
            </span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The strip's throughput readout: cumulative output tokens in, a rate out.
 *
 * Readings come whenever `stats` moves AND once a second, because a stall is
 * only visible as time passing without a movement; the figure resets with the
 * run it describes (`agentStartedAt`, cleared on `agent_settled`).
 */
function useGenRate(
  agentStartedAt: number | null,
  outputTokens: number | undefined,
): GenRate | null {
  const samples = useRef<GenSample[]>([])
  const [rate, setRate] = useState<GenRate | null>(null)

  useEffect(() => {
    resetGenSamples(samples.current)
    setRate(null)
  }, [agentStartedAt])

  useEffect(() => {
    if (!agentStartedAt) return
    const sample = (): void => {
      if (outputTokens != null) recordGenSample(samples.current, Date.now(), outputTokens)
      setRate(genRateFrom(samples.current, Date.now()))
    }
    sample()
    const interval = setInterval(sample, 1000)
    return () => clearInterval(interval)
  }, [agentStartedAt, outputTokens])

  return rate
}
