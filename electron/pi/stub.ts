import { app } from 'electron'

/**
 * E2E hook: PHOSPHOR_PI_STUB points at a script that speaks the RPC protocol in
 * place of the real pi binary, so CI can smoke-test without an API key.
 *
 * Gated on `!app.isPackaged`. The hook makes the main process execute an
 * arbitrary script as Node (`ELECTRON_RUN_AS_NODE`) while reporting pi as
 * healthy, so honoring it in a shipped app would turn an environment variable
 * into local code execution. Playwright drives an unpackaged build, so the
 * tests are unaffected.
 *
 * Lives in its own module because more than one handler needs it and this gate
 * must have exactly one definition. It was previously private to
 * `pi-session-handlers.ts`, which is how `pi:catalogueModels` came to spawn the
 * REAL pi binary during e2e runs — the one spawn that never consulted the stub.
 */
export function piStubPath(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.PHOSPHOR_PI_STUB || undefined
}
