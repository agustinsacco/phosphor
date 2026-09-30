/**
 * Extensions Phosphor loads into EVERY session, regardless of provider or
 * agent (omp loads pi's extension API too): artifacts (tools the model can
 * call), context-breakdown (context composition and the session-local window
 * cap used by the agent's native compaction), worktree-paths (refuses a file
 * read that has escaped into the main checkout of a worktree session),
 * tool-name-guard (keeps a malformed tool call out of the session file, where
 * it would brick every later turn), mcp-status (per-server MCP state for the
 * connectors UI), and headroom (compresses large tool results through the
 * local Headroom proxy as they are produced; inert unless
 * PHOSPHOR_HEADROOM_URL is set at spawn).
 *
 * All six files in pi-ext/ are listed here — keep this comment and the array
 * in step, since nothing else records why a given one is loaded. Resolved to
 * a path by `bundledExtensions()` in `session-runtime.ts`; kept free of
 * Electron so `scripts/omp-compat.ts` loads exactly this list.
 */
export const BUNDLED_EXTENSION_FILES: readonly string[] = [
  'artifacts.ts',
  'context-breakdown.ts',
  'worktree-paths.ts',
  'tool-name-guard.ts',
  'mcp-status.ts',
  'headroom.ts',
]
