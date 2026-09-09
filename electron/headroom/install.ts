import { failedJob, resolveBinary, startJob, type JobSender } from '../pi/packages'
import { piProcessEnv } from '../pi/shell-env'

/**
 * Guided Headroom install as a streamed job (same channels as package jobs,
 * so the renderer's existing job listeners work unchanged).
 *
 * Never silent and never automatic: this only runs when the user clicks
 * Install on the Optimization tab, and the full installer output streams to
 * the UI. `headroom-ai[proxy]` is a ~500 MB Python environment — exactly the
 * kind of thing Phosphor must not do in the background.
 */
export async function runHeadroomInstall(sender: JobSender): Promise<{ jobId: string }> {
  const env = await piProcessEnv()

  // uv first (isolated tool venv, fast resolver), pipx as the fallback —
  // both give `headroom` on PATH without touching the user's site-packages.
  const uv = await resolveBinary('uv')
  if (uv) {
    return startJob(sender, uv, ['tool', 'install', '--python', '3.13', 'headroom-ai[proxy]'], {
      env: env as Record<string, string>,
    })
  }
  const pipx = await resolveBinary('pipx')
  if (pipx) {
    return startJob(sender, pipx, ['install', 'headroom-ai[proxy]'], {
      env: env as Record<string, string>,
    })
  }
  return failedJob(
    sender,
    'Neither uv nor pipx was found on your PATH. Install uv (https://docs.astral.sh/uv/) ' +
      'and retry, or install Headroom yourself: uv tool install --python 3.13 "headroom-ai[proxy]"',
  )
}
