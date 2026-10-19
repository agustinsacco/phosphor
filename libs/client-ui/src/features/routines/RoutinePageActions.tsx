import { Button } from '@/components/form'

/** Header controls shared by every shell displaying the full routine page. */
export function RoutinePageActions({
  unsaved,
  onImport,
  onCreate,
}: {
  unsaved: boolean
  onImport: () => void
  onCreate: () => void
}): React.JSX.Element {
  return (
    <>
      <Button size="sm" onClick={onImport}>
        Import
      </Button>
      <Button
        size="sm"
        variant="primary"
        title={unsaved ? 'Pick up the routine you were writing' : undefined}
        onClick={onCreate}
      >
        {unsaved ? 'Resume draft' : 'New routine'}
      </Button>
    </>
  )
}
