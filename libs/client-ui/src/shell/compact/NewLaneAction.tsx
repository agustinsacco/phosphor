import { Button } from '@/components/form'
import { PlusIcon } from '@/components/icons'
import { useNavigation } from '@/navigation/Navigation'
import { useScopedMachine } from './useBrowserScope'

/**
 * Starts a lane where you are: the machine in view, else the last one you looked at. The
 * start page then opens on that machine's last folder (the lane you last opened there, or
 * the folder you last started in). `floating` is the phone's thumb-reach button.
 */
export function NewLaneAction({ floating = false }: { floating?: boolean }): React.JSX.Element {
  const { navigate } = useNavigation()
  const machine = useScopedMachine()
  const open = (): void => navigate({ to: 'new', ...(machine ? { machine } : {}) })
  // `absolute` tells the shared hit-slop rule not to make the floating button relative.
  return floating ? (
    <Button variant="primary" size="lg" className="new-lane-fab absolute" onClick={open}>
      <PlusIcon size={18} /> New lane
    </Button>
  ) : (
    <Button aria-label="New lane" onClick={open}>
      <PlusIcon size={17} />
    </Button>
  )
}
