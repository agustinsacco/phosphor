/**
 * Which pi-ext artifact tools mint a new artifact version.
 *
 * A leaf module on purpose: `stores/sessions.ts` needs this predicate, and
 * `stores/artifacts.ts` imports `stores/layout.ts`, which imports
 * `stores/sessions.ts`. Importing the predicate from the artifacts store
 * would rebuild that cycle — which is why the store itself is reached from
 * sessions via `void import('./artifacts')`.
 *
 * `artifact_read` and `artifact_list` are deliberately absent: read echoes a
 * version that already exists, and ingesting it would re-fire the unseen
 * badge for content the user has already been shown.
 */
const ARTIFACT_WRITE_TOOLS = new Set(['artifact_create', 'artifact_update', 'artifact_edit'])

export function isArtifactWriteTool(toolName: string): boolean {
  return ARTIFACT_WRITE_TOOLS.has(toolName)
}
