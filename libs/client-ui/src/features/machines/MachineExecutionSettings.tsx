import { useEffect, useState } from 'react'
import type { MachineModel } from '@shared/host-protocol-machine'
import type { ThinkingLevel } from '@shared/rpc'
import { Button } from '@/components/form'
import { promptChoice, promptText } from '@/stores/prompt'
import { openMachinePage } from '@/stores/machinePages'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { Card, Fact, Facts, Skeleton, StatusPill } from './MachineUi'
import { HostFolderBrowser } from './HostFolderBrowser'
import { useMachineAgentDraft } from './machineSettingsDrafts'
import type { HostSettingsState } from './useHostSettings'
import type { MachinePrograms } from './MachineProviderSettings'

export function MachineAgentSettings({
  hostId,
  label,
  settings,
  repositoryId,
}: {
  hostId: string
  label: string
  settings: HostSettingsState
  repositoryId?: string
}): React.JSX.Element | null {
  const state = settings.data?.agent
  const [models, setModels] = useState<MachineModel[] | null>(null)
  const [catalogueFailed, setCatalogueFailed] = useState(false)
  const draft = useMachineAgentDraft(hostId, repositoryId, settings)
  const { model, thinking, budget, naming } = draft.fields
  const setModel = (value: string) => draft.set('model', value)
  const setThinking = (value: ThinkingLevel) => draft.set('thinking', value)
  const setBudget = (value: string) => draft.set('budget', value)
  const setNaming = (value: boolean) => draft.set('naming', value)
  useEffect(() => {
    let live = true
    setModels(null)
    setCatalogueFailed(false)
    void window.phosphor.invoke('hosts:models', hostId).then(
      (rows) => {
        if (live) setModels(rows)
      },
      () => {
        if (live) setCatalogueFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [hostId])
  if (!state) return null
  const busy = settings.loading || settings.saving || draft.stale
  const saveModel = async () => {
    const selected = models?.find((m) => JSON.stringify([m.provider, m.id]) === model)
    if (!selected) return
    if (
      (await promptChoice({
        title: `Save agent defaults on ${label}?`,
        message: `${selected.name} (${selected.provider}), thinking ${thinking}. ${repositoryId ? 'This folder only; machine defaults stay unchanged.' : 'Machine defaults for new lanes.'} Existing lanes are not restarted.`,
        choices: [{ value: 'save', label: `Save on ${label}`, primary: true }],
      })) === 'save'
    )
      await draft.save({
        type: 'agent.patch',
        patch: {
          defaultProvider: selected.provider,
          defaultModel: selected.id,
          defaultThinkingLevel: thinking,
        },
      })
  }
  const knownModel = models?.some((m) => JSON.stringify([m.provider, m.id]) === model)
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Agent defaults</h2>
        <p className="text-text-secondary mt-1 text-base">
          Starting choices for new lanes on {label}. Explicit lane choices take precedence.
        </p>
      </div>
      {repositoryId && settings.data?.projectTrusted === false && (
        <p className="text-warning text-base">
          This folder is not trusted by pi on {label}. Folder defaults can be saved, but will not
          apply until project trust is explicitly approved under Folders. Machine defaults remain
          active.
        </p>
      )}
      {draft.stale && (
        <div role="alert" className="text-warning space-y-2 text-base">
          <p>
            The Host settings changed while you were editing. Your draft is kept, but it cannot
            overwrite the newer revision.
          </p>
          <Button size="sm" onClick={draft.discard}>
            Discard draft and use current settings
          </Button>
        </div>
      )}
      <Card title="New lane defaults">
        <div className="space-y-4">
          <label className="block text-base">
            Provider and model
            {models === null && !catalogueFailed ? (
              <Skeleton className="mt-2 h-8 w-full" />
            ) : (
              <select
                aria-label="Default Host model"
                value={model}
                disabled={busy || catalogueFailed}
                onChange={(e) => setModel(e.target.value)}
                className="border-border bg-bg mt-1 w-full rounded-md border p-2"
              >
                <option value="">
                  {state.defaultModel
                    ? `${state.defaultProvider ?? 'provider'}/${state.defaultModel} · choose from catalogue to change`
                    : 'Use pi’s existing default; choose a model to change'}
                </option>
                {model && !knownModel && (
                  <option value={model}>Saved model is unavailable in this catalogue</option>
                )}
                {models?.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={JSON.stringify([m.provider, m.id])}>
                    {m.name} · {m.provider}
                  </option>
                ))}
              </select>
            )}
          </label>
          {catalogueFailed && (
            <p role="alert" className="text-warning text-base">
              Could not read {label}’s model catalogue. No local models are substituted.
            </p>
          )}
          <label className="block text-base">
            Thinking level
            <select
              aria-label="Default Host thinking"
              value={thinking}
              disabled={busy}
              onChange={(e) => setThinking(e.target.value as ThinkingLevel)}
              className="border-border bg-bg mt-1 w-full rounded-md border p-2"
            >
              {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </label>
          <div className="flex justify-end">
            <Button disabled={busy || !knownModel} onClick={() => void saveModel()}>
              {settings.saving ? 'Saving…' : 'Review model defaults'}
            </Button>
          </div>
        </div>
      </Card>
      {!repositoryId && (
        <Card title="Host policy" aside="Requires a Host service restart">
          <div className="space-y-4">
            <label className="block text-base">
              Context budget
              <input
                aria-label="Host context budget"
                value={budget}
                disabled={busy}
                onChange={(e) => setBudget(e.target.value)}
                className="border-border bg-bg mt-1 w-full rounded-md border p-2"
              />
              <span className="text-text-secondary mt-1 block text-sm">
                Default 200k. One budget for native and Claude Code lanes. Automatic compaction
                keeps response headroom.
              </span>
            </label>
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                disabled={busy}
                checked={naming}
                onChange={(e) => setNaming(e.target.checked)}
              />
              Automatically name new lanes
            </label>
            <Button
              disabled={busy}
              onClick={() =>
                void (async () => {
                  if (
                    (await promptChoice({
                      title: `Save Host policy on ${label}?`,
                      message:
                        'This writes the Host configuration. It does not restart the service or stop lanes. The saved policy takes effect after an explicit Host service restart.',
                      choices: [{ value: 'save', label: 'Save policy', primary: true }],
                    })) === 'save'
                  )
                    await draft.save({
                      type: 'agent.patch',
                      patch: { contextBudget: budget.trim(), autoNameLanes: naming },
                    })
                })()
              }
            >
              Review Host policy
            </Button>
            <p className="text-text-tertiary text-sm">
              To apply saved Host policy, explicitly restart the service on {label} when running
              work can stop. Model defaults above do not need a service restart.
            </p>
          </div>
        </Card>
      )}
    </div>
  )
}

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
      <Card title="User-managed packages">
        {!resources.packages.length ? (
          <p className="text-text-secondary text-base">No user packages reported by this Host.</p>
        ) : (
          <ul className="divide-border divide-y">
            {resources.packages.map((pkg) => (
              <li
                key={`${pkg.scope}/${pkg.spec}`}
                className="flex flex-wrap items-center gap-3 py-3"
              >
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
          project-local package mutations must be managed on the Host; this page does not guess
          their scope.
        </p>
      </Card>
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

export function MachineFolderSettings({
  hostId,
  label,
  programs,
}: {
  hostId: string
  label: string
  programs: MachinePrograms
}): React.JSX.Element {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold">Folders</h2>
          <p className="text-text-secondary mt-1 text-base">
            Folders registered on {label}. These are Host paths, never this computer’s files.
          </p>
        </div>
        <Button
          disabled={busy || !host?.capabilities.includes('workspaces.write')}
          onClick={() => setAdding(true)}
        >
          Add folder
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-danger text-base">
          {error}
        </p>
      )}
      <Card title="Configured repositories">
        {host?.repositories.map((repo) => (
          <div
            key={repo.id}
            className="border-border flex flex-wrap items-center gap-3 border-b py-3 last:border-0"
          >
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-medium">{repo.name}</h3>
              <p className="text-text-secondary break-all font-mono text-sm">{repo.path}</p>
            </div>
            <Button
              size="xs"
              disabled={busy || programs.busy || !programs.available}
              onClick={() => programs.task({ task: 'folder.trust', repositoryId: repo.id })}
            >
              Review project trust
            </Button>
            <Button
              size="xs"
              disabled={busy || !host?.capabilities.includes('workspaces.write')}
              onClick={() =>
                void (async () => {
                  if (
                    (await promptChoice({
                      title: `Unregister ${repo.name} on ${label}?`,
                      message:
                        'Files are never deleted. Existing lane history remains. A folder with active lanes may refuse removal.',
                      choices: [{ value: 'remove', label: 'Unregister folder', primary: true }],
                    })) !== 'remove'
                  )
                    return
                  setBusy(true)
                  setError(null)
                  try {
                    await window.phosphor.invoke('hosts:removeRepository', hostId, repo.id)
                  } catch {
                    setError('Folder removal not confirmed. Refresh the Host before trying again.')
                  } finally {
                    setBusy(false)
                  }
                })()
              }
            >
              Unregister
            </Button>
          </div>
        ))}
        {!host?.repositories.length && (
          <p className="text-text-secondary text-base">No registered folders yet.</p>
        )}
      </Card>
      <p className="text-text-tertiary text-sm">
        Registration is not a filesystem sandbox. Project trust is separate: it permits pi to load
        project configuration and executable MCP commands. Review that code before approving.
      </p>
      {adding && (
        <HostFolderBrowser
          hostId={hostId}
          onClose={() => setAdding(false)}
          onAdded={() => setAdding(false)}
        />
      )}
    </div>
  )
}

export function MachineAdvancedSettings({
  label,
  settings,
}: {
  label: string
  settings: HostSettingsState
}): React.JSX.Element | null {
  const runtime = settings.data?.advanced
  if (!runtime) return null
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Advanced</h2>
        <p className="text-text-secondary mt-1 text-base">
          Read-only execution diagnostics from {label}. Secret values are never returned.
        </p>
      </div>
      <Card title="Runtime">
        <Facts>
          <Fact label="Platform">{runtime.platform}</Fact>
          <Fact label="Host version">{runtime.hostVersion}</Fact>
          <Fact label="Host config">
            <code className="font-mono text-sm">{runtime.configPath}</code>
          </Fact>
          <Fact label="pi agent directory">
            <code className="font-mono text-sm">{runtime.piAgentDir}</code>
          </Fact>
        </Facts>
      </Card>
      <Card title="Environment availability">
        {runtime.environment.map((variable) => (
          <div key={variable.name} className="flex items-center justify-between gap-3 py-2">
            <code className="font-mono text-base">{variable.name}</code>
            <StatusPill tone={variable.available && variable.passed ? 'ok' : 'off'}>
              {variable.available && variable.passed
                ? 'Passed to pi'
                : variable.available
                  ? 'Not passed'
                  : 'Missing from service'}
            </StatusPill>
          </div>
        ))}
        {!runtime.environment.length && (
          <p className="text-text-secondary text-base">
            No additional environment variables are allowlisted.
          </p>
        )}
        <p className="text-text-tertiary mt-3 text-sm">
          Set secret values in the Host service’s environment, not in this page or the control
          plane. An interactive SSH shell’s variables may differ from the service.
        </p>
      </Card>
      <Card title="Executable search path">
        <ul className="space-y-1">
          {runtime.path.map((path, index) => (
            <li key={`${index}/${path}`} className="break-all font-mono text-sm">
              {path}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
