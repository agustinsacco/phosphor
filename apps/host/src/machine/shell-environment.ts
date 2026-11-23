import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import { userInfo } from 'node:os'
import { captureShellEnvironment } from '@phosphor/session-runtime/pi/shell-env'
import { acceptsShellName, buildPiEnvironment, type PiEnvironment } from './environment'
import type { HostLog } from './log'
import { probe } from './probe'

type Policy = Parameters<typeof buildPiEnvironment>[0]

/** One cache per validated local machine. No periodic timer and no profile reads at spawn. */
export function createShellEnvironment(policy: Policy, timeoutMs = 15_000) {
  const base = buildPiEnvironment(policy)
  let current = base
  let additions: Record<string, string> = {}
  let log: HostLog | undefined
  let unavailable = false
  let inFlight: Promise<boolean> | undefined

  async function capture(): Promise<boolean> {
    // The interactive and fallback forms share a deadline, including both halves of the probe.
    const deadline = performance.now() + Math.min(15_000, timeoutMs)
    try {
      const shell = policy.hostEnv.SHELL || userInfo().shell || '/bin/zsh'
      const result = await captureShellEnvironment({
        shell: () => shell,
        env: () => policy.hostEnv,
        platform: () => policy.platform,
        now: Date.now,
        // PATH in env -0 also distinguishes a successful empty allowlist from a failed probe.
        accepts: (name) => name === 'PATH' || acceptsShellName(name, policy.pass ?? []),
        run: async (file, args, limits) => {
          const remaining = Math.min(limits.timeoutMs, deadline - performance.now())
          if (remaining <= 0) throw new Error('capture timed out')
          const output = await probe(file, args, {
            env: { ...base.env, PATH: policy.hostEnv.PATH ?? base.env.PATH! },
            // Private capture only: parse the raw values; never forward output or error text.
            secrets: [],
            timeoutMs: remaining,
            maxBytes: limits.maxBytes,
          })
          if (output.code !== 0 || output.truncated || output.timedOut)
            throw new Error('capture failed')
          return output.stdout
        },
      })
      if (!result?.path.length || !result.values.PATH) throw new Error('incomplete capture')
      const next = buildPiEnvironment({ ...policy, shell: result })
      log?.addSecrets(next.secrets)
      additions = Object.fromEntries(
        Object.entries(next.env).filter(([key, value]) => value !== base.env[key]),
      )
      current = next
      unavailable = false
      return true
    } catch {
      unavailable = true
      log?.write('host', 'environment.shell_unavailable')
      return false
    }
  }
  return {
    current: (): PiEnvironment => current,
    additions: () => additions,
    refresh() {
      return (inFlight ??= capture().finally(() => {
        inFlight = undefined
      }))
    },
    bindLog(target: HostLog) {
      log = target
      log.addSecrets(current.secrets)
      if (unavailable) log.write('host', 'environment.shell_unavailable')
    },
  }
}

export type HostShellEnvironment = ReturnType<typeof createShellEnvironment>

// Shell capture is part of local mode, not a standalone release feature.
export const FEATURE: HostReleaseFeature | null = null
