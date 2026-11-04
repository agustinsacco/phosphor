import { MIN_PI_VERSION } from '@shared/models'
import { isNewerVersion } from '@shared/version'
import { useHostSection } from '../../machine/HostSection'
import type { AdvancedSource, PiFacts } from './source'

const CAPS = { rawFiles: false, maintenance: false } as const

/**
 * The Host's pi against the minimum Phosphor supports, as This Mac's health
 * check holds it. A Host that could not read its version is not judged.
 */
function hostPi(pi: { version?: string; path: string }): PiFacts {
  const tooOld = pi.version !== undefined && isNewerVersion(MIN_PI_VERSION, pi.version)
  return {
    ok: !tooOld,
    version: pi.version,
    location: pi.path,
    minVersion: MIN_PI_VERSION,
    ...(tooOld ? { problem: 'too-old' } : {}),
  }
}

/** A Host's update, runtime, pi, PATH and environment names; never values or raw editors. */
export function useHostAdvanced(): AdvancedSource {
  const { machine, settings, programs } = useHostSection()
  const runtime = settings.data?.advanced
  return {
    status: runtime ? 'ready' : 'loading',
    notice:
      runtime && !runtime.pi
        ? {
            tone: 'info',
            title: 'Update this Host to see its pi',
            body: 'Hosts from before this release do not report their pi version or install path.',
          }
        : null,
    caps: CAPS,
    pi: runtime?.pi && hostPi(runtime.pi),
    agentDir: runtime?.pi?.agentDir ?? runtime?.piAgentDir,
    path: runtime?.path,
    environment: runtime?.environment,
    runtime: runtime && {
      product: 'Host',
      version: runtime.hostVersion,
      platform: runtime.platform,
      configPath: runtime.configPath,
      update: {
        note: `Install the newest signed Phosphor Host release on ${machine.label}. Its lanes pause while it restarts, and a failed health check brings the old version back.${programs.available ? '' : ' Needs Host terminal access.'}`,
        action: 'Pause and update',
        disabled: !programs.available || programs.busy,
        run: () => programs.task({ task: 'host.update' }),
      },
    },
    footnote:
      'Secret values are never returned. Set them in the Host service’s environment, not in this page or the control plane; an interactive SSH shell’s variables may differ from the service.',
  }
}
