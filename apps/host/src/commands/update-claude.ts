import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { CLAUDE_PROVIDER_PACKAGE } from '@phosphor/shared/models'
import { loadHostConfig } from '../config/load'
import { buildPiEnvironment } from '../machine/environment'
import { setupTerminal } from './setup-terminal'
import type { UpdateContext } from './update'

/** Bounds the provider update so a stalled pi or npm never holds the Host update open. */
export const CLAUDE_PROVIDER_UPDATE_TIMEOUT_MS = 120_000

/** Provider updates are best effort and never roll back a verified Host release. */
export async function updateClaudeProvider(
  context: UpdateContext,
  lifetime?: AbortSignal,
): Promise<void> {
  const bounded = AbortSignal.timeout(CLAUDE_PROVIDER_UPDATE_TIMEOUT_MS)
  const signal = lifetime ? AbortSignal.any([lifetime, bounded]) : bounded
  try {
    signal.throwIfAborted()
    const packages = await (context.packages ?? listPackages)()
    signal.throwIfAborted()
    if (!packages.some((pkg) => pkg.name === CLAUDE_PROVIDER_PACKAGE && pkg.installed)) return
    const loaded = await loadHostConfig(context.configPath, context.uid)
    if (!loaded.ok) throw new Error('config')
    const config = loaded.config
    const environment = buildPiEnvironment({
      hostEnv: context.env,
      platform: context.platform,
      ...config.environment,
      nodePath: config.pi.node,
    })
    const terminal =
      context.setupTerminal ??
      setupTerminal(environment.env, signal, context.json ? 2 : 1, context.screen)
    const args = [
      ...(config.pi.node ? [config.pi.executable] : []),
      'update',
      `npm:${CLAUDE_PROVIDER_PACKAGE}`,
    ]
    context.progress?.({ step: 'provider' })
    if ((await terminal.run(config.pi.node ?? config.pi.executable, args, 'task')) !== 0)
      throw new Error('update')
  } catch {
    // Cancellation (SIGTERM, Ctrl-C) ends the update; only the provider's own failure is a warning.
    lifetime?.throwIfAborted()
    context.print(
      'Warning: Claude provider update failed. Run: pi update npm:@saccolabs/pi-claude-cli',
    )
  }
}
