import { join } from 'node:path'

/**
 * The same six extensions run in every interactive or routine pi session.
 * The caller supplies the resource root; neither the host nor this module
 * needs Electron to resolve the files. Stub sessions deliberately omit them.
 */
export const BUNDLED_EXTENSION_FILES = [
  'artifacts.ts',
  'context-breakdown.ts',
  'worktree-paths.ts',
  'tool-name-guard.ts',
  'headroom.ts',
  'lane-reload.ts',
] as const

export function bundledExtensions(resourceRoot: string): string[] {
  return BUNDLED_EXTENSION_FILES.map((file) => join(resourceRoot, 'pi-ext', file))
}
