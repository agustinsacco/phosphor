import { dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { controlMachine } from '../../control/__fixtures__/machine'
import { fakeMachine, EXTENSIONS_ROOT } from '../../__fixtures__/machine'
import { writeSidecar } from '../../config/sidecar'
import { hostStateDirectory, prepareStateDirectory } from '../../lanes/state-dir'
import { buildPiEnvironment } from '../../machine/environment'
import type { HostMachine } from '../../session/runtime'
import type { Drainable } from '../../shutdown'
import type { RunContext } from '../run'

export interface LocalRunOptions {
  enrolled: boolean
  /** Writes `local-mode.json` beside the config. */
  marker: boolean
  /** Writes `owner-standby.json` in the state folder. */
  standby?: boolean
  /** What control answers a running heartbeat. */
  heartbeat: 'accepted' | 'gone'
}

/**
 * A Host with a real pi stub, a temporary config, state and agent folder,
 * optionally marked as a machine's local daemon. Nothing touches the real home.
 */
export async function localRunMachine(options: LocalRunOptions) {
  const control = await controlMachine()
  const pi = fakeMachine({ rpc: true })
  const beats: string[] = []
  const env = { XDG_STATE_HOME: join(control.root, 'state'), PI_CODING_AGENT_DIR: pi.agentDir }
  const cleanup = async () => {
    await control.cleanup()
    pi.cleanup()
  }
  try {
    if (options.enrolled) await control.enrollOld()
    const uid = control.context.uid
    if (options.marker)
      writeSidecar(
        dirname(control.configPath),
        HOST_SIDECARS.localMode,
        { version: 1, enabledAt: new Date(0).toISOString(), shellEnvironment: false },
        { uid, known: [] },
      )
    const state = hostStateDirectory(env, pi.home)
    if (options.standby) {
      prepareStateDirectory(state, uid)
      writeSidecar(state, HOST_SIDECARS.standby, { version: 1 }, { uid, known: [] })
    }
    const machine: Omit<HostMachine, 'log'> = {
      pi: { binaryPath: process.execPath, prefixArgs: [pi.cli] },
      env: buildPiEnvironment({
        hostEnv: pi.hostEnv,
        nodePath: process.execPath,
        platform: process.platform,
      }).env,
      roots: [pi.repository],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
    }
    let target: Drainable | undefined
    const context = (): RunContext => ({
      ...control.context,
      env,
      home: pi.home,
      nodeVersion: process.versions.node,
      defaultResourceRoot: EXTENSIONS_ROOT,
      heartbeat: {
        readiness: async () => ({ pi: 'ok', claude: 'ok', tailscale: 'ok' }),
        random: () => 0,
        seq: { read: async () => 0, write: async () => {} },
      },
      attach: (drainable) => {
        target = drainable
        return () => {}
      },
      fetch: async (_url, init) => {
        const body: unknown = JSON.parse(String(init?.body))
        const beat = body && typeof body === 'object' && 'state' in body ? body.state : undefined
        beats.push(String(beat))
        if (beat === 'running' && options.heartbeat === 'gone')
          return new Response(null, { status: 410 })
        return Response.json({ accepted: true, nextInSec: 30 })
      },
      // Real, abortable waits: the drain is what ends a local run.
      wait: (ms, signal) => setTimeout(ms, undefined, { signal }),
    })
    return {
      control,
      pi,
      env,
      state,
      machine,
      beats,
      context,
      target: () => target,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}
