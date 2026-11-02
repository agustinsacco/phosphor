import { create } from 'zustand'

/** A Host's packages as its nested Extensions items need them. */
export type HostPackageNames = readonly { spec: string; name: string; installed: boolean }[]

/**
 * Each Host's last `resources` package list, by Host id. The navigation reads
 * a Host once; the Extensions page publishes every read after it, so a
 * finished install or removal lists or drops the package's own item.
 */
export const useHostExtensionPackages = create<Record<string, HostPackageNames>>(() => ({}))

export function publishHostPackages(hostId: string, packages: HostPackageNames): void {
  useHostExtensionPackages.setState({ [hostId]: packages })
}
