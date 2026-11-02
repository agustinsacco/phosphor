import { useHostSection } from '../../machine/HostSection'
import type { AdvancedSource } from './source'

const CAPS = { rawFiles: false, maintenance: false } as const

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
    pi: runtime?.pi && { ok: true, version: runtime.pi.version, location: runtime.pi.path },
    agentDir: runtime?.pi?.agentDir ?? runtime?.piAgentDir,
    path: runtime?.path,
    environment: runtime?.environment,
    host: runtime && {
      version: runtime.hostVersion,
      platform: runtime.platform,
      configPath: runtime.configPath,
      updateNote: `Install the newest signed Phosphor Host release on ${machine.label}. Its lanes pause while it restarts, and a failed health check brings the old version back.${programs.available ? '' : ' Needs Host terminal access.'}`,
      canUpdate: programs.available && !programs.busy,
      update: () => programs.task({ task: 'host.update' }),
    },
    footnote:
      'Secret values are never returned. Set them in the Host service’s environment, not in this page or the control plane; an interactive SSH shell’s variables may differ from the service.',
  }
}
