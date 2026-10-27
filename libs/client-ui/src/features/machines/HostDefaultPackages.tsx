import { HOST_DEFAULT_PACKAGES } from '@shared/host-default-packages'
import type { MachineSettings } from '@shared/machine-settings'
import { Button } from '@/components/form'
import { Card, StatusPill } from './MachineUi'
import type { MachinePrograms } from './MachineProviderSettings'

export function HostDefaultPackages({
  resources,
  busy,
  programs,
}: {
  resources: NonNullable<MachineSettings['resources']>
  busy: boolean
  programs: MachinePrograms
}): React.JSX.Element {
  return (
    <Card title="Standard Host extensions">
      <p className="text-text-secondary mb-3 text-base">
        Included in guided Host setup. These work on headless machines; computer use is not
        installed. Packages run with full access as the Host user.
      </p>
      <ul className="divide-border divide-y">
        {HOST_DEFAULT_PACKAGES.map((entry) => {
          const pkg = resources.packages.find((p) => p.name === entry.name && p.scope === 'global')
          return (
            <li key={entry.name} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-medium">{entry.title}</h3>
                <p className="text-text-secondary text-base">{entry.description}</p>
              </div>
              <StatusPill tone={pkg?.installed ? 'ok' : 'off'}>
                {pkg?.installed ? 'Installed' : 'Not installed'}
              </StatusPill>
              {!pkg?.installed && (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    programs.task({
                      task: 'package.install',
                      name: pkg?.spec.startsWith('npm:') ? pkg.spec : entry.spec,
                    })
                  }
                >
                  {pkg ? 'Repair installation' : `Install ${entry.title}`}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
