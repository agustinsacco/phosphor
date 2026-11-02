import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { TooltipButton } from '@/components/Tooltip'
import { sessionTitle } from '@/lib/sessionTitle'
import { useNavigation } from '@/navigation/Navigation'
import { useChatStore, type ChatSession } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { orderTasks, type MachineTask } from './machineTasks'
import { StatusDot } from './MachineUi'

const TASKS_SHOWN = 3

function localTitle(chat: ChatSession | undefined): string {
  const first = chat?.items.find((item) => item.kind === 'user')
  return (
    sessionTitle({
      explicitName: chat?.meta?.sessionName,
      firstUserText: first?.kind === 'user' ? first.text : undefined,
    }) ?? 'New session'
  )
}

/** This computer's running lanes: a streaming turn, or an extension dialog waiting on you. */
export function useLocalTasks(): MachineTask[] {
  const live = useSessionsStore((s) => s.live)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const ids = useMemo(
    () =>
      Object.values(live)
        .filter((entry) => entry.target?.kind !== 'remote')
        .map((entry) => entry.phosphorId),
    [live],
  )
  const asking = useExtensionUiStore(
    useShallow((s) => ids.filter((id) => s.dialogs.some((d) => d.sessionId === id))),
  )
  const working = useChatStore(
    useShallow((s) =>
      ids.filter((id) => !asking.includes(id) && s.sessions[id]?.isStreaming === true),
    ),
  )
  const activeIds = [...asking, ...working]
  // Strings, not objects, so a streaming token does not re-render the page.
  const titles = useChatStore(useShallow((s) => activeIds.map((id) => localTitle(s.sessions[id]))))
  return orderTasks(
    activeIds.map((id, index) => {
      const branch = gitByCwd[live[id]?.workspacePath ?? '']?.branch
      return {
        key: id,
        title: titles[index] ?? 'New session',
        ...(branch ? { branch } : {}),
        state: asking.includes(id) ? 'needs-input' : 'working',
        lane: { sessionId: id },
      }
    }),
  )
}

/**
 * The lanes a machine is running, under its row on the Machines list. Each
 * opens its lane; the rest are one click away on the machine's lane list.
 */
export function MachineTasks({
  machine,
  tasks,
}: {
  /** The lane scope the overflow link opens: a Host id, or `local`. */
  machine: string
  tasks: readonly MachineTask[]
}): React.JSX.Element | null {
  const { navigate } = useNavigation()
  if (!tasks.length) return null
  const hidden = tasks.length - TASKS_SHOWN
  return (
    <ul aria-label="Running lanes" className="machine-tasks">
      {tasks.slice(0, TASKS_SHOWN).map((task) => (
        <li key={task.key}>
          <TooltipButton
            tooltip={`Open ${task.title}`}
            data-task-state={task.state}
            className="machine-task"
            onClick={() => navigate({ to: 'lane', lane: task.lane })}
          >
            <span className="machine-task-glyph">
              {task.state === 'working' ? (
                <PhosphorLoader size={14} decorative />
              ) : (
                <StatusDot tone="warn" />
              )}
            </span>
            <span className="min-w-0 truncate">{task.title}</span>
            {task.branch && (
              <span className="text-text-tertiary hidden min-w-0 truncate font-mono text-xs md:block">
                {task.branch}
              </span>
            )}
            <span
              className={
                task.state === 'working'
                  ? 'text-text-tertiary ml-auto shrink-0'
                  : 'text-warning ml-auto shrink-0 font-medium'
              }
            >
              {task.state === 'working' ? 'Working' : 'Needs input'}
            </span>
          </TooltipButton>
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <TooltipButton
            className="machine-task-more"
            onClick={() => navigate({ to: 'lanes', machine })}
          >
            {hidden} more →
          </TooltipButton>
        </li>
      )}
    </ul>
  )
}
