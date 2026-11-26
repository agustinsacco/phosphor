import { Button, Row } from '@/components/form'
import type { MachineUpdate } from '@/features/updates/useAppUpdate'
import { platformName } from '@shared/platform-name'
import type { MachineRuntime } from './source'

/** A machine's update action, with one line about it. */
export function MachineUpdateRow({
  title,
  update,
}: {
  title: string
  update: MachineUpdate
}): React.JSX.Element {
  return (
    <Row title={title} description={update.note}>
      <Button
        variant={update.primary ? 'primary' : undefined}
        disabled={update.disabled}
        onClick={update.run}
      >
        {update.action}
      </Button>
    </Row>
  )
}

/** What runs the machine: its update, version and platform, and a Host's config file. */
export function MachineRuntimeRows({ runtime }: { runtime: MachineRuntime }): React.JSX.Element {
  return (
    <>
      {runtime.product === 'Phosphor' && (
        <>
          {runtime.update && <MachineUpdateRow title="Phosphor updates" update={runtime.update} />}
          <Row
            title="Phosphor version"
            description={runtime.platform && platformName(runtime.platform)}
          >
            <code className="font-mono text-sm">{runtime.version}</code>
          </Row>
        </>
      )}
      {runtime.configPath && (
        <Row title="Host config" description="Folders, policy and the allowlisted environment.">
          <code className="break-all font-mono text-sm">{runtime.configPath}</code>
        </Row>
      )}
    </>
  )
}
