import { EXIT } from '../checks'
import { loadHostConfig } from '../config/load'
import {
  inspectTailscale,
  routeMessage,
  successfulProbe,
  tailscaleMessage,
  tailscaleOptions,
  tailscalePorts,
} from '../machine/tailscale'
import type { DoctorContext } from './doctor'

export type TailscaleAction = 'status' | 'enable' | 'disable'
export const isTailscaleAction = (value: unknown): value is TailscaleAction =>
  value === 'status' || value === 'enable' || value === 'disable'

export async function runTailscale(
  context: Pick<DoctorContext, 'configPath' | 'uid' | 'env' | 'platform'>,
  action: TailscaleAction,
  ports = tailscalePorts,
): Promise<{ exitCode: number; message: string }> {
  const loaded = await loadHostConfig(context.configPath, context.uid)
  if (!loaded.ok)
    return {
      exitCode: EXIT.config,
      message: 'Config is not usable. Run phosphor doctor to check it.',
    }
  const inspect = () => inspectTailscale(loaded.config, context.env, context.platform, ports)
  const found = await inspect()
  const { state, port, executable, name } = found
  const unusableName =
    'Tailscale did not report a usable .ts.net name for this machine; check tailscale status.'
  if (action === 'status')
    return {
      exitCode: state === 'ours' && name !== null ? EXIT.ok : EXIT.unavailable,
      message:
        `Tailscale serve: ${state}\nEndpoint: ${found.endpoint ?? 'null'}\n` +
        (found.readiness !== 'ok'
          ? tailscaleMessage(found.readiness)
          : name === null
            ? unusableName
            : routeMessage(state, port)),
    }
  if (state === 'other' || state === 'funnel')
    return { exitCode: EXIT.config, message: routeMessage(state, port) }
  if (!executable || found.readiness !== 'ok')
    return { exitCode: EXIT.unavailable, message: tailscaleMessage(found.readiness) }
  if (name === null) return { exitCode: EXIT.unavailable, message: unusableName }
  if (state === 'unknown') return { exitCode: EXIT.unavailable, message: routeMessage(state, port) }
  if ((action === 'enable' && state === 'ours') || (action === 'disable' && state === 'absent'))
    return {
      exitCode: EXIT.ok,
      message: `Tailscale serve: ${state}. Already ${action === 'enable' ? 'enabled' : 'disabled'}.`,
    }
  const args =
    action === 'enable'
      ? ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`]
      : ['serve', `--https=${port}`, 'off']
  const run = await ports.probe(
    executable,
    args,
    tailscaleOptions(loaded.config, context.env, context.platform),
  )
  if (!successfulProbe(run))
    return {
      exitCode: EXIT.tempfail,
      message:
        'Tailscale serve could not be changed.' +
        (context.platform === 'linux'
          ? ' One-time fix on Linux: sudo tailscale set --operator=$USER'
          : ''),
    }
  const after = await inspect()
  const expected = action === 'enable' ? 'ours' : 'absent'
  if (after.state !== expected)
    return {
      exitCode: EXIT.tempfail,
      message: `Tailscale serve change could not be verified. ${routeMessage(after.state, port)}`,
    }
  return { exitCode: EXIT.ok, message: `Tailscale serve: ${after.state}.` }
}
