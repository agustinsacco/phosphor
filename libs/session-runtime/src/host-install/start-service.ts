import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HOST_AGENT, HOST_UNIT } from '@phosphor/shared/host-local'

/** Start only an already registered per-user service. Never install or restart a running job. */
export async function startInstalledService(
  platform: NodeJS.Platform,
  uid: number | undefined,
  run: (file: string, args: string[]) => Promise<unknown> = (file, args) =>
    promisify(execFile)(file, args, { timeout: 10_000 }),
  names = { agent: HOST_AGENT, unit: HOST_UNIT },
): Promise<void> {
  if (platform === 'linux') await run('/usr/bin/systemctl', ['--user', 'start', names.unit])
  else if (platform === 'darwin' && Number.isSafeInteger(uid) && uid !== undefined && uid >= 0)
    await run('/bin/launchctl', ['kickstart', `gui/${uid}/${names.agent}`])
  else throw new Error('Starting the Phosphor service is not supported here.')
}
