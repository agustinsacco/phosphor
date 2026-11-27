import { useMemo } from 'react'
import clsx from 'clsx'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useCurrentWork } from '@/features/chat/currentWork'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { laneAgents, laneDoing, type LaneAgents } from './laneWork'

const DOT_LIMIT = 5
const STACK_LIMIT = 5

/**
 * What a live lane is doing and which sub-agents it is running. Rows without
 * a session in this client (stored, or a Host lane not opened here) get none.
 */
export function useLaneWork(sessionId: string | undefined): {
  doing?: string
  agents: LaneAgents | null
} {
  const id = sessionId ?? ''
  const work = useCurrentWork(id)
  const since = useChatStore((s) => s.sessions[id]?.agentStartedAt ?? null)
  return useMemo(
    () => ({ doing: laneDoing(work.tools, since), agents: laneAgents(work.entries, since) }),
    [work, since],
  )
}

/** The session this client holds for a Host lane, if it has opened it. */
export function useHostLaneSessionId(hostId: string | undefined, laneId: string) {
  return useSessionsStore((s) =>
    hostId
      ? Object.values(s.live).find(
          (e) => e.target?.kind === 'remote' && e.target.hostId === hostId && e.laneId === laneId,
        )?.phosphorId
      : undefined,
  )
}

function stateText(agent: { running: boolean; failed: boolean }): string {
  return agent.running ? 'running' : agent.failed ? 'failed' : 'done'
}

/** One dot per sub-agent, then `running/total`, beside the PR beads. */
export function AgentDots({ agents }: { agents: LaneAgents }): React.JSX.Element {
  const total = agents.agents.length
  return (
    <span
      data-testid="lane-agent-dots"
      role="img"
      aria-label={`${agents.running} of ${total} sub-agents running`}
      data-tooltip={agents.agents.map((a) => `${a.label} · ${stateText(a)}`).join('\n')}
      className="flex shrink-0 items-center gap-1"
    >
      <span className="flex items-center gap-0.5">
        {agents.agents.slice(0, DOT_LIMIT).map((a) => (
          <span
            key={a.id}
            className={clsx(
              'size-1.5 rounded-full',
              a.running ? 'bg-accent animate-pulse' : a.failed ? 'bg-danger' : 'bg-success',
            )}
          />
        ))}
      </span>
      <span className="text-text-tertiary text-sm tabular-nums">
        {agents.running}/{total}
      </span>
    </span>
  )
}

/** The open lane's sub-agents, one line each, under its row. */
export function AgentStack({ agents }: { agents: LaneAgents }): React.JSX.Element {
  const more = agents.agents.length - STACK_LIMIT
  return (
    <ul
      data-testid="lane-agent-stack"
      aria-label="Sub-agents"
      className="border-border mb-1 ml-[2.125rem] mr-2 border-l pl-2"
    >
      {agents.agents.slice(0, STACK_LIMIT).map((a) => (
        <li
          key={a.id}
          data-state={stateText(a)}
          className="text-text-secondary flex items-center gap-1.5 text-sm leading-[18px]"
        >
          {a.running ? (
            <PhosphorLoader size={12} decorative />
          ) : (
            <span className={clsx('w-3 text-center', a.failed ? 'text-danger' : 'text-success')}>
              {a.failed ? '✕' : '✓'}
            </span>
          )}
          <span className="text-text shrink-0 font-medium">{a.label}</span>
          {a.detail && <span className="min-w-0 truncate">{a.detail}</span>}
        </li>
      ))}
      {more > 0 && <li className="text-text-tertiary pl-[18px] text-sm">+{more} more</li>}
    </ul>
  )
}
