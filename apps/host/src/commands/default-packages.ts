import { join } from 'node:path'
import { HOST_DEFAULT_PACKAGES } from '@phosphor/shared/host-default-packages'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { buildPiEnvironment } from '../machine/environment'
import { loadHostConfig } from '../config/load'
import { setupTerminal } from './setup-terminal'
import type { GuidedSetupContext } from './guided-setup'
import { inspectClaude } from '../machine/claude'
import type { ProbeEnvironment } from '../machine/probe'

export async function inspectSetupClaude(
  context: GuidedSetupContext,
  environment: ProbeEnvironment,
) {
  const packages = await (context.packages ?? listPackages)(
    undefined,
    environment.env.PI_CODING_AGENT_DIR ?? join(context.home, '.pi', 'agent'),
  )
  return inspectClaude(packages, environment)
}

type DefaultPackageContext = Pick<
  GuidedSetupContext,
  | 'configPath'
  | 'uid'
  | 'env'
  | 'platform'
  | 'home'
  | 'packages'
  | 'setupTerminal'
  | 'signal'
  | 'json'
  | 'print'
>

/** Install through pi, never npm directly: retain its settings, pins and npmCommand.
 * Setup owns consent; no service or lane is restarted and no credentials are touched. */
export async function installDefaultPackages(context: DefaultPackageContext): Promise<void> {
  const loaded = await loadHostConfig(context.configPath, context.uid)
  if (!loaded.ok) throw new Error('Cannot install Host extensions with invalid configuration.')
  const config = loaded.config
  const { env } = buildPiEnvironment({
    hostEnv: context.env,
    platform: context.platform,
    ...config.environment,
    nodePath: config.pi.node,
  })
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(context.home, '.pi', 'agent')
  const installed = await (context.packages ?? listPackages)(undefined, agentDir)
  const missing = HOST_DEFAULT_PACKAGES.filter(
    (entry) => !installed.some((pkg) => pkg.name === entry.name && pkg.installed),
  )
  if (!missing.length) return
  const terminal = context.setupTerminal ?? setupTerminal(env, context.signal, context.json ? 2 : 1)
  if (
    !(await terminal.confirm(
      'Install the standard Host extensions (Claude provider, swarm subagents and web access)?',
      'These pi packages run with full access as your user. Computer use is not installed.',
    ))
  ) {
    context.print(
      'Host extensions skipped. Install them later in Machine Settings → Skills & extensions.',
    )
    return
  }
  for (const entry of missing) {
    const existing = installed.find((pkg) => pkg.name === entry.name)
    const spec = existing?.spec ?? entry.spec
    const args = [...(config.pi.node ? [config.pi.executable] : []), 'install', spec]
    context.signal?.throwIfAborted()
    if ((await terminal.run(config.pi.node ?? config.pi.executable, args)) !== 0)
      throw new Error(`Host extension installation failed. Retry: pi install ${spec}`)
    context.print(`  ✓ ${entry.title}`)
  }
}
