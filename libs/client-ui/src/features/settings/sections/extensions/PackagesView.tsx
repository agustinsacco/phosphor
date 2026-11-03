import { useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { Button, Select, TextInput } from '@/components/form'
import { isMachinePackageSpec } from '@shared/machine-settings'
import { StandardPackages } from './StandardPackages'
import { PackageRow } from './PackageRow'
import type { PackageSource } from './packageSource'
import { SectionStatusNotice } from '../sectionStatus'

/**
 * Settings → Extensions on every machine: pi packages (extensions, skills,
 * prompts and themes). The source reads the machine's packages and runs pi's
 * own package manager there; its caps say what that machine allows.
 */
export function PackagesView({ source }: { source: PackageSource }): React.JSX.Element {
  const { caps, packages, busy } = source
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Extensions</h2>
      <p className="text-text-secondary mt-1 text-base">
        pi packages — extensions, skills, prompts and themes. New sessions load package changes.
        Installs run through pi&apos;s own package manager.
      </p>
      <div className="mt-4 empty:hidden">
        <SectionStatusNotice
          status={source.status}
          title="Could not read this machine’s packages"
        />
      </div>

      <h3 className="mt-5 text-lg font-semibold">Recommended</h3>
      <div className="mt-2.5">
        <StandardPackages
          packages={packages ?? []}
          claudeCli={source.claudeCli}
          headless={caps.headless}
          busy={busy || packages === null}
          onInstall={(spec) => source.run('install', spec, 'global')}
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

      <InstalledPackages source={source} />
      <AddPackage source={source} />
      {source.output}
    </div>
  )
}

function InstalledPackages({ source }: { source: PackageSource }): React.JSX.Element {
  const { packages } = source
  const scopes = source.folder ? (['global', 'project'] as const) : (['global'] as const)
  return (
    <>
      {scopes.map((scope) => {
        const listed = (packages ?? []).filter((pkg) => pkg.scope === scope)
        return (
          <div key={scope}>
            <h3 className="mt-6 text-lg font-semibold">
              {scope === 'global' ? 'Installed for the machine' : 'Installed in this folder'}
            </h3>
            {packages === null ? (
              <div className="text-text-tertiary mt-2 text-base">Reading pi settings…</div>
            ) : listed.length === 0 ? (
              <div className="text-text-tertiary mt-2 text-base">none</div>
            ) : (
              <div className="border-border divide-border mt-2 divide-y rounded-lg border">
                {listed.map((pkg) => (
                  <PackageRow key={`${pkg.scope}:${pkg.spec}`} pkg={pkg} source={source} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

function AddPackage({ source }: { source: PackageSource }): React.JSX.Element {
  const { caps, busy } = source
  const [spec, setSpec] = useState('')
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const trimmed = spec.trim()
  const valid = trimmed !== '' && (caps.anySource || isMachinePackageSpec(trimmed))
  const folderScope = caps.projectScope && source.folder
  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">Add a package</h3>
      <div className="mt-2 flex items-center gap-2">
        <TextInput
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          aria-label="Package spec"
          placeholder={
            caps.anySource
              ? 'npm:pkg, git:github.com/user/repo, or /absolute/path'
              : 'npm:@scope/package@1.2.3'
          }
          className="min-w-0 flex-1 font-mono"
        />
        {folderScope && (
          <Select
            label="Install for"
            value={scope}
            options={[
              { value: 'global', label: 'The machine' },
              { value: 'project', label: 'This folder' },
            ]}
            onChange={setScope}
          />
        )}
        <Button
          variant="primary"
          onClick={() => source.run('install', trimmed, folderScope ? scope : 'global')}
          disabled={busy || !valid}
        >
          Install
        </Button>
        {caps.updateAll && (
          <Button
            onClick={() => source.run('update', undefined, 'global')}
            disabled={busy}
            title="pi update --extensions"
          >
            Update all
          </Button>
        )}
      </div>
      {!caps.anySource && (
        <p className="text-text-tertiary mt-2 text-sm">
          npm packages only, for the whole machine. Bundled Phosphor extensions update with the
          Host; packages from git, a path or a folder are managed on the Host itself.
        </p>
      )}
    </>
  )
}
