import type { ReactNode } from 'react'

export const PACKAGE_CONTENT_KINDS = [
  ['skills', 'Skills'],
  ['prompts', 'Prompts'],
  ['extensions', 'Extensions'],
  ['themes', 'Themes'],
] as const
export type PackageContentKind = (typeof PACKAGE_CONTENT_KINDS)[number][0]

/** One pi package on the machine, as either machine reports it. */
export interface PackageItem {
  spec: string
  name: string
  version?: string
  scope: 'global' | 'project'
  installed: boolean
  filtered: boolean
  /** What it brings: names on This Mac, counts from a Host. Null when not reported. */
  contents: Record<PackageContentKind, readonly string[] | number> | null
}

export type PackageAction = 'install' | 'update' | 'remove'

/** How the machines differ in managing packages. */
export interface PackageCaps {
  /** git and path specs as well as npm. A Host takes npm only. */
  anySource: boolean
  /** Installs into the folder in scope. A Host installs for the whole machine only. */
  projectScope: boolean
  /** One action updates every package. */
  updateAll: boolean
  /** Asks the registry for newer versions; without it Update is always offered. */
  versionCheck: boolean
  /** Recommends only packages that run without a desktop session. */
  headless: boolean
}

/** The Extensions page's data and actions on one machine. */
export interface PackageSource {
  caps: PackageCaps
  /** Null while the first read is in flight. */
  packages: readonly PackageItem[] | null
  /** A failed read, with its retry. */
  failure: { error: string; retry: () => void } | null
  /** Whether a folder is in scope, so its packages are listed too. */
  folder: boolean
  /** The registry's latest version per spec, when `versionCheck`. */
  latest: Readonly<Record<string, string | null>>
  /** Whether the `claude` CLI is on PATH; null when unknown. */
  claudeCli: boolean | null
  /** An action is running or cannot start. */
  busy: boolean
  /** Removing asks first on every machine. */
  run(action: PackageAction, spec: string | undefined, scope: 'global' | 'project'): void
  openSkills(): void
  /** What the running or last action printed, when the machine streams it here. */
  output: ReactNode
}
