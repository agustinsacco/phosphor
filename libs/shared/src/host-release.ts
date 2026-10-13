export const HOST_RELEASE_NAMESPACE = 'phosphor-host-release'
export const HOST_RELEASE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const
export type HostReleaseTarget = (typeof HOST_RELEASE_TARGETS)[number]
export interface HostReleaseKey {
  id: string
  publicKey: string
}
// The operator adds the release signing public key before publishing releases.
export const HOST_RELEASE_KEYS: readonly HostReleaseKey[] = []
export const HOST_RELEASE_MANIFEST_MAX_BYTES = 16 * 1024
export const HOST_RELEASE_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024
export const HOST_RELEASE_VERSION_PATTERN =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
export interface HostReleaseArtifact {
  target: HostReleaseTarget
  file: string
  bytes: number
  sha256: string
}
export interface HostReleaseManifest {
  schema: 1
  version: string
  protocols: number[]
  node: string
  sourceCommit: string
  artifacts: HostReleaseArtifact[]
}
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
export function parseHostReleaseManifest(value: unknown): HostReleaseManifest | null {
  if (
    !record(value, ['schema', 'version', 'protocols', 'node', 'sourceCommit', 'artifacts']) ||
    value.schema !== 1 ||
    typeof value.version !== 'string' ||
    !HOST_RELEASE_VERSION_PATTERN.test(value.version) ||
    typeof value.node !== 'string' ||
    !HOST_RELEASE_VERSION_PATTERN.test(value.node) ||
    typeof value.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    !Array.isArray(value.protocols) ||
    value.protocols.length < 1 ||
    value.protocols.length > 8 ||
    !value.protocols.every((p): p is number => Number.isSafeInteger(p) && p >= 1 && p <= 65535) ||
    new Set(value.protocols).size !== value.protocols.length ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.length < 1 ||
    value.artifacts.length > HOST_RELEASE_TARGETS.length
  )
    return null
  const artifacts: HostReleaseArtifact[] = []
  for (const a of value.artifacts) {
    if (!record(a, ['target', 'file', 'bytes', 'sha256'])) return null
    const target = HOST_RELEASE_TARGETS.find((t) => t === a.target)
    if (
      !target ||
      a.file !== `phosphor-host-${value.version}-${target}.tar.gz` ||
      typeof a.bytes !== 'number' ||
      !Number.isSafeInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > HOST_RELEASE_ARTIFACT_MAX_BYTES ||
      typeof a.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(a.sha256) ||
      artifacts.some((entry) => entry.target === target)
    )
      return null
    artifacts.push({ target, file: a.file, bytes: a.bytes, sha256: a.sha256 })
  }
  return {
    schema: 1,
    version: value.version,
    node: value.node,
    sourceCommit: value.sourceCommit,
    protocols: value.protocols,
    artifacts,
  }
}
