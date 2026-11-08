import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { MachineDot } from '@/features/sessions/MachineSwitcher'
import { useNavigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

/**
 * The phone's machine scope for Home: every machine, or one. It writes the same URL scope
 * as the wide browser's "Lanes on" switcher, which a wide browser shows instead.
 */
export function MachineScopeChips({ machine }: { machine?: string }): React.JSX.Element | null {
  const { navigate } = useNavigation()
  const compact = usePlatform().formFactor === 'compact'
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  if (!compact || (machines.length < 2 && !machine)) return null
  const chip = (id: string | undefined, label: React.ReactNode) => (
    <TooltipButton
      key={id ?? 'all'}
      tooltip={false}
      aria-pressed={machine === id}
      className={clsx('hit-slop machine-chip', machine === id && 'machine-chip-on')}
      onClick={() => navigate({ to: 'lanes', ...(id ? { machine: id } : {}) })}
    >
      {label}
    </TooltipButton>
  )
  return (
    <div role="group" aria-label="Lanes on" className="machine-chips">
      {chip(undefined, 'All machines')}
      {machines.map((m) =>
        chip(
          m.id,
          <>
            <MachineDot state={hosts[m.id]?.state} />
            {m.label}
          </>,
        ),
      )}
    </div>
  )
}
