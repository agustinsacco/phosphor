import { PageBody } from '@/components/PageBody'
import { PageShell } from '@/components/PageShell'
import { HomeBoard } from '@/features/home/HomeBoard'
import { UpdatesFooter } from '@/features/updates/UpdatesFooter'
import { usePlatform } from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { LaneListNotices } from './CompactLanes'
import { MachineScopeChips } from './MachineScopeChips'

/**
 * The browser's Home: every machine's lanes on the shared Home board (what needs you, what
 * runs, where you were). A machine chip opens that machine's full lane list.
 */
export function CompactHome(): React.JSX.Element {
  const machines = useMachinesStore((s) => s.machines.length)
  // As on the phone's Lanes page: under All machines it carries running updates and held results.
  const compact = usePlatform().formFactor === 'compact'
  return (
    <PageShell title="Home" dismissible={false}>
      <MachineScopeChips />
      <PageBody>
        {compact && <UpdatesFooter />}
        <section className="space-y-4" aria-label="Home">
          <LaneListNotices empty={machines === 0} />
          {machines > 0 && <HomeBoard />}
        </section>
      </PageBody>
    </PageShell>
  )
}
