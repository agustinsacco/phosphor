import { PageBody } from '@/components/PageBody'
import { PageShell } from '@/components/PageShell'
import { HomeBoard } from '@/features/home/HomeBoard'
import { useMachinesStore } from '@/stores/machines'
import { LaneListNotices } from './CompactLanes'
import { MachineScopeChips } from './MachineScopeChips'

/**
 * The browser's Home: every machine's lanes on the shared Home board (what needs you, what
 * runs, where you were). A machine chip opens that machine's full lane list.
 */
export function CompactHome(): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines.length)
  return (
    <PageShell title="Home" dismissible={false}>
      <MachineScopeChips />
      <PageBody>
        <section className="space-y-4" aria-label="Home">
          <LaneListNotices empty={machines === 0} />
          {machines > 0 && <HomeBoard />}
        </section>
      </PageBody>
    </PageShell>
  )
}
