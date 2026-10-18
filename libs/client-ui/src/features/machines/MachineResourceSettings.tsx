import { Button } from '@/components/form'
import { openMachinePage } from '@/stores/machinePages'
import { promptText } from '@/stores/prompt'
import type { MachinePrograms } from './MachineProviderSettings'
import { Card, StatusPill } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'

import type { MachineSettings } from '@shared/machine-settings'
export function MachineResourceSettings({
  hostId,
  label,
  settings,
  programs,
}: {
  hostId: string
  label: string
  settings: HostSettingsState
  programs: MachinePrograms
}): React.JSX.Element | null {
  const resources = settings.data?.resources
  if (!resources) return null
  const busy = settings.loading || settings.saving || programs.busy || !programs.available
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Skills & extensions</h2>
          <p className="text-text-secondary mt-1 text-base">
            Installed on {label}, not this computer. New lanes load package changes.
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() =>
            void (async () => {
              const spec = await promptText({
                title: `Install a package on ${label}`,
                message: 'Enter an npm package spec. It will be installed on this Host only.',
                placeholder: 'npm:@scope/package@1.2.3',
              })
              if (spec) programs.task({ task: 'package.install', name: spec.trim() })
            })()
          }
        >
          Install npm package
        </Button>
      </div>
      <MachinePackages {...{ resources, busy, programs }} />
      <Card title="Skills">
        <p className="text-text-secondary mb-3 text-base">
          Inspect and use the existing machine-filtered Skills page. Project skills remain attached
          to their own folder.
        </p>
        <Button size="sm" onClick={() => openMachinePage('skills', hostId)}>
          Open skills on {label}
        </Button>
      </Card>
    </div>
  )
}

function MachinePackages({
  resources,
  busy,
  programs,
}: {
  resources: NonNullable<MachineSettings['resources']>
  busy: boolean
  programs: MachinePrograms
}): React.JSX.Element {
  return (
    <Card title="User-managed packages">
      {!resources.packages.length ? (
        <p className="text-text-secondary text-base">No user packages reported by this Host.</p>
      ) : (
        <ul className="divide-border divide-y">
          {resources.packages.map((pkg) => (
            <li key={`${pkg.scope}/${pkg.spec}`} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-medium">{pkg.name}</h3>
                <p className="text-text-secondary break-all font-mono text-sm">
                  {pkg.spec} · {pkg.version ?? 'version not reported'} · {pkg.scope}
                </p>
              </div>
              <StatusPill tone={pkg.installed ? 'ok' : 'off'}>
                {pkg.installed ? 'Installed' : 'Not found'}
              </StatusPill>
              <Button
                size="xs"
                disabled={busy || pkg.scope === 'project' || !pkg.spec.startsWith('npm:')}
                onClick={() => programs.task({ task: 'package.update', name: pkg.spec })}
              >
                Update
              </Button>
              <Button
                size="xs"
                disabled={busy || pkg.scope === 'project' || !pkg.spec.startsWith('npm:')}
                onClick={() => programs.task({ task: 'package.remove', name: pkg.spec })}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-text-tertiary mt-3 text-sm">
        Bundled Phosphor extensions are protected and update with the Host. Non-npm and
        project-local package mutations must be managed on the Host; this page does not guess their
        scope.
      </p>
    </Card>
  )
}
