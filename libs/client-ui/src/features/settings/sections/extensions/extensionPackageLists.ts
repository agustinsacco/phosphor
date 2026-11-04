import { create } from 'zustand'
import type { SettingsMachine } from '../../settingsUiStore'

/** A machine's packages as its nested Extensions items need them. */
export type PackageNames = readonly { spec: string; installed: boolean }[]

/** One list per machine and scope (null: the whole machine), so no scope's read stands in for another's. */
export const packageListKey = (machine: SettingsMachine, folder: string | null): string =>
  `${machine}\n${folder ?? ''}`

/**
 * Each machine's last package list per scope (`packageListKey`). The navigation
 * reads the scope line's own; a Host's Extensions page publishes every read after
 * it, so a finished install or removal lists or drops the package's own item.
 */
export const useExtensionPackageLists = create<Record<string, PackageNames>>(() => ({}))

export function publishPackageList(
  machine: SettingsMachine,
  folder: string | null,
  packages: PackageNames,
): void {
  useExtensionPackageLists.setState({ [packageListKey(machine, folder)]: packages })
}
