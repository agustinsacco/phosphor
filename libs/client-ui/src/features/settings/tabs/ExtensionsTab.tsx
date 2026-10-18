import { TooltipButton } from '@/components/Tooltip'
import { useCallback, useEffect, useState } from 'react'
import type { PiPackageEntry } from '@shared/models'
import { useActiveWorkspace } from '@/stores/workspaces'
import { Button } from '@/components/form'
import { CatalogueCards } from '../CatalogueCards'
import { JobOutput } from '../JobOutput'
import { usePackageJob } from '../usePackageJob'
import { isNewerVersion } from '@shared/version'
import { errorText } from '@shared/errors'
import { useLayoutStore } from '@/stores/layout'
import { useSkillsStore } from '@/stores/skills'
import { useSettingsUiStore } from '../settingsUiStore'

/**
 * Settings → Extensions: pi package management. Reads come from settings
 * files + install dirs; every mutation shells out to pi's own package
 * manager (`pi install` / `pi remove` / `pi update`) with streamed output.
 */
export function ExtensionsTab(): React.JSX.Element {
  const workspacePath = useActiveWorkspace()
  const [entries, setEntries] = useState<PiPackageEntry[] | null>(null)
  const [latest, setLatest] = useState<Record<string, string | null>>({})
  const [claudeDetected, setClaudeDetected] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addSpec, setAddSpec] = useState('')
  const [addScope, setAddScope] = useState<'global' | 'project'>('global')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, detect] = await Promise.all([
        window.phosphor.invoke('packages:list', workspacePath ?? undefined),
        window.phosphor.invoke('packages:detect'),
      ])
      setEntries(list)
      setClaudeDetected(detect.claude)
      // Registry lookup is slower than the local reads and may fail
      // (offline, private registry) — never let it block the listing.
      void window.phosphor
        .invoke('packages:checkUpdates', workspacePath ?? undefined)
        .then(setLatest)
        .catch(() => setLatest({}))
    } catch (err) {
      setError(errorText(err))
    }
  }, [workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const job = usePackageJob(() => void refresh())

  const runAction = (
    action: 'install' | 'remove' | 'update',
    spec: string | undefined,
    scope: 'global' | 'project',
  ): void => {
    setError(null)
    void job.start(() =>
      window.phosphor.invoke('packages:run', action, spec, scope, workspacePath ?? undefined),
    )
  }

  const specs = (entries ?? []).map((e) => e.spec)
  const byScope = (scope: 'global' | 'project'): PiPackageEntry[] =>
    (entries ?? []).filter((e) => e.scope === scope)

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Extensions</h2>
      <p className="text-text-secondary mt-1 text-base">
        pi packages — extensions, skills, prompts and themes. Open sessions pick up changes before
        their next message. Installs run through pi&apos;s own package manager.
      </p>

      <h3 className="mt-5 text-lg font-semibold">Recommended</h3>
      <div className="mt-2.5">
        <CatalogueCards
          installedSpecs={specs}
          claudeDetected={claudeDetected}
          busy={job.running}
          onInstall={(spec) => runAction('install', spec, 'global')}
        />
      </div>
      <p className="text-text-tertiary mt-2 text-sm">
        Browse the full ecosystem at{' '}
        <TooltipButton
          onClick={() => void window.phosphor.invoke('app:openExternal', 'https://pi.dev/packages')}
          className="hover:text-text underline"
        >
          pi.dev/packages
        </TooltipButton>
        . Packages run with full system access — review before installing.
      </p>

      {(['global', 'project'] as const).map((scope) => {
        const scoped = byScope(scope)
        if (scope === 'project' && !workspacePath) return null
        return (
          <div key={scope}>
            <h3 className="mt-6 text-lg font-semibold">
              {scope === 'global' ? 'Installed (all workspaces)' : 'Installed (this workspace)'}
            </h3>
            {entries === null ? (
              <div className="text-text-tertiary mt-2 text-base">Reading pi settings…</div>
            ) : scoped.length === 0 ? (
              <div className="text-text-tertiary mt-2 text-base">none</div>
            ) : (
              <div className="border-border mt-2 divide-y rounded-lg border">
                {scoped.map((entry) => (
                  <PackageRow
                    key={`${entry.scope}:${entry.spec}`}
                    entry={entry}
                    latest={latest[entry.spec] ?? null}
                    busy={job.running}
                    onUpdate={() => runAction('update', entry.spec, entry.scope)}
                    onRemove={() => runAction('remove', entry.spec, entry.scope)}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}

      <h3 className="mt-6 text-lg font-semibold">Add a package</h3>
      <div className="mt-2 flex items-center gap-2">
        <input
          value={addSpec}
          onChange={(e) => setAddSpec(e.target.value)}
          placeholder="npm:pkg, git:github.com/user/repo, or /absolute/path"
          className="border-border bg-bg-secondary focus:border-accent min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-base outline-none"
        />
        {workspacePath && (
          <select
            value={addScope}
            onChange={(e) => setAddScope(e.target.value as 'global' | 'project')}
            className="border-border bg-bg-secondary rounded-md border px-2 py-1.5 text-base"
          >
            <option value="global">Global</option>
            <option value="project">This workspace</option>
          </select>
        )}
        <Button
          variant="primary"
          onClick={() => {
            if (addSpec.trim()) runAction('install', addSpec.trim(), addScope)
          }}
          disabled={job.running || !addSpec.trim()}
        >
          Install
        </Button>
        <Button
          onClick={() => runAction('update', undefined, 'global')}
          disabled={job.running}
          title="pi update --extensions"
        >
          Update all
        </Button>
      </div>

      {error && <div className="text-danger mt-3 text-base">{error}</div>}
      <JobOutput running={job.running} output={job.output} exitCode={job.exitCode} />
    </div>
  )
}

function PackageRow({
  entry,
  latest,
  busy,
  onUpdate,
  onRemove,
}: {
  entry: PiPackageEntry
  /** Latest published version, or null when unknown. */
  latest: string | null
  busy: boolean
  onUpdate: () => void
  onRemove: () => void
}): React.JSX.Element {
  const updatable =
    latest !== null && entry.version !== undefined && isNewerVersion(latest, entry.version)
  return (
    <div className="flex items-start justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-lg font-medium">{entry.name}</span>
          {entry.version && (
            <span className="text-text-tertiary font-mono text-sm">v{entry.version}</span>
          )}
          {updatable && (
            <span className="text-accent bg-accent-soft rounded-full px-2 py-0.5 font-mono text-sm">
              v{latest} available
            </span>
          )}
          {!entry.installed && (
            <span className="text-warning text-sm">installs on next session start</span>
          )}
          {entry.filtered && (
            <span
              className="text-text-tertiary text-sm"
              data-tooltip="Resource filters in settings"
            >
              filtered
            </span>
          )}
        </div>
        <div className="text-text-tertiary mt-0.5 truncate font-mono text-sm">{entry.spec}</div>
        {entry.installed && <PackageContents entry={entry} />}
      </div>
      {updatable && (
        <TooltipButton
          onClick={onUpdate}
          disabled={busy}
          className="bg-accent hover:bg-accent-hover text-accent-text mr-1 shrink-0 rounded-md px-2.5 py-1 text-base font-medium transition-colors disabled:opacity-50"
        >
          Update
        </TooltipButton>
      )}
      <TooltipButton
        onClick={onRemove}
        disabled={busy}
        className="text-danger hover:bg-danger-soft shrink-0 rounded-md px-2 py-1 text-sm font-medium transition-colors disabled:opacity-50"
      >
        Remove
      </TooltipButton>
    </div>
  )
}

const CONTENT_KINDS = [
  ['skills', 'Skills'],
  ['prompts', 'Prompts'],
  ['extensions', 'Extensions'],
  ['themes', 'Themes'],
] as const

/**
 * What a package brings, by name: its skills (with a jump to the Skills page,
 * where they group under the package), prompt commands, extension entry points
 * and themes. Read from the install dir, so it is what the package declares;
 * a "filtered" entry may load less.
 */
function PackageContents({ entry }: { entry: PiPackageEntry }): React.JSX.Element {
  const rows = CONTENT_KINDS.filter(([kind]) => entry.resources[kind].length > 0)
  if (rows.length === 0) {
    return <div className="text-text-tertiary mt-1 text-sm">No resources found</div>
  }
  const openSkills = (): void => {
    useSettingsUiStore.getState().setOpen(false)
    useSkillsStore.getState().setTab('yours')
    useLayoutStore.getState().setPage('skills')
  }
  return (
    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {rows.map(([kind, label]) => {
        const names = entry.resources[kind]
        return (
          <div key={kind} className="contents">
            <dt className="text-text-tertiary">
              {label} ({names.length})
            </dt>
            <dd className="text-text-secondary min-w-0 font-mono break-words">
              {names.map((name) => (kind === 'prompts' ? `/${name}` : name)).join(', ')}
              {kind === 'skills' && (
                <TooltipButton
                  onClick={openSkills}
                  className="text-accent ml-2 font-sans hover:underline"
                >
                  View in Skills
                </TooltipButton>
              )}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
