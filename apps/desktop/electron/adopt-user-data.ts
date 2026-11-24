import { dirname, join } from 'node:path'

/** Keep an isolated test from even probing either installed profile. */
export function adoptLegacyUserData(ports: {
  isPackaged: boolean
  testUserData?: string
  userData(): string
  exists(path: string): boolean
  rename(before: string, after: string): void
}): void {
  if (!ports.isPackaged && ports.testUserData) return
  try {
    const current = ports.userData()
    const legacy = join(dirname(current), 'pidex')
    if (!ports.exists(current) && ports.exists(legacy)) ports.rename(legacy, current)
  } catch {
    // A failed migration means first-run defaults, not a broken launch.
  }
}
