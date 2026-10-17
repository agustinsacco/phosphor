/**
 * The dev server the main window loads in place of the bundled renderer, or
 * `undefined` to load the bundle.
 *
 * `electron-vite dev` sets ELECTRON_RENDERER_URL so an unpackaged run gets HMR.
 * Gated on packaging like the other env hooks (see pi/stub.ts:piStubPath): the
 * window carries the privileged preload, so honoring the variable in a shipped
 * app would let an environment variable hand that bridge to any page.
 */
export function devRendererUrl(env: NodeJS.ProcessEnv, isPackaged: boolean): string | undefined {
  if (isPackaged) return undefined
  return env.ELECTRON_RENDERER_URL || undefined
}
