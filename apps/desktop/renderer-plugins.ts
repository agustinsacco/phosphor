import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { PluginOption } from 'vite'

/**
 * The renderer's Vite plugins, shared by `electron.vite.config.ts` and the
 * browser harness in `vite.config.ts`.
 *
 * Both configs run Desktop's own vite (electron-vite's, and the harness's
 * `defineConfig`), but these plugins come from the root install and are typed
 * against the root's vite. The two copies share a version, yet TypeScript
 * treats them as one package only when both installs also carry the same
 * optional vite peers (yaml, lightningcss), and npm does not keep those in
 * step. The cast makes the configs typecheck regardless of what each lockfile
 * happens to hold.
 */
export function rendererPlugins(): PluginOption[] {
  return [react(), tailwindcss()] as unknown as PluginOption[]
}
