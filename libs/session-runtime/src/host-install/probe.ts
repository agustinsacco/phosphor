import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { isVersion } from '@phosphor/shared/control-api'
import { HOST_RELEASE_V2_LIMITS } from '@phosphor/shared/host-release'

export interface BundleVersion {
  hostVersion: string
  protocolVersion: number
  features: string[]
}

/** Only call after signature and artifact verification. Do not inherit NODE_OPTIONS or credentials. */
export async function probeStagedBundle(
  stage: string,
  signal: AbortSignal,
): Promise<BundleVersion> {
  const { stdout } = await promisify(execFile)(
    resolve(stage, 'node/bin/node'),
    [resolve(stage, 'lib/phosphor.mjs'), 'version', '--json'],
    {
      cwd: stage,
      env: { PATH: '/usr/bin:/bin' },
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      signal,
      killSignal: 'SIGKILL',
    },
  )
  const value: unknown = JSON.parse(stdout)
  if (
    !value ||
    typeof value !== 'object' ||
    !('hostVersion' in value) ||
    !isVersion(value.hostVersion) ||
    !('protocolVersion' in value) ||
    typeof value.protocolVersion !== 'number' ||
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion < 1
  )
    throw new Error('Invalid staged service version.')
  const features: unknown = 'features' in value ? value.features : []
  if (
    !Array.isArray(features) ||
    features.length > HOST_RELEASE_V2_LIMITS.features ||
    !features.every((name): name is string => typeof name === 'string' && name.length <= 64)
  )
    throw new Error('Invalid staged service features.')
  return { hostVersion: value.hostVersion, protocolVersion: value.protocolVersion, features }
}
