import { Button } from '@/components/form'

/** What a model picker offers when it has nothing to pick: Retry models, Sign in on a machine. */
export interface ModelAction {
  label: string
  run: () => void
}

/** The model pickers' and the no-models banner's actions, as one row of buttons. */
export function ModelActionButtons({
  actions,
}: {
  actions: readonly ModelAction[]
}): React.JSX.Element {
  return (
    <>
      {actions.map((action) => (
        <Button key={action.label} size="sm" onClick={action.run}>
          {action.label}
        </Button>
      ))}
    </>
  )
}
