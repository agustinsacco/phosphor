export const HOST_RELEASE_NAMESPACE = 'phosphor-host-release'
// The extractor derives modes from these paths, not from archive headers.
const executablePaths = new Set([
  'bin/phosphor',
  'node/bin/node',
  'lib/native/node-pty/build/Release/spawn-helper',
])
export function hostReleaseFileMode(path: string): number {
  return executablePaths.has(path) ? 0o755 : 0o644
}
export const HOST_RELEASE_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-arm64'] as const
export type HostReleaseTarget = (typeof HOST_RELEASE_TARGETS)[number]
export interface HostReleaseKey {
  id: string
  publicKey: string
}
// Release signing public keys. The private half exists only as the
// HOST_RELEASE_SIGNING_KEY repository secret. Append a new key before rotating.
export const HOST_RELEASE_KEYS: readonly HostReleaseKey[] = [
  {
    id: 'phosphor-host-release-2026-10',
    publicKey:
      'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINswBTu86+bi4tXFWnoIf6lHw0MwkPtqnqyN+KfxM3AN phosphor-host-release',
  },
]
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

// ---------- manifest v2 ----------
// v1 stays byte-compatible and frozen at three targets: an old updater reads
// only `phosphor-host[-<tag>].manifest.json`, and its parser refuses a fourth
// target. v2 is a separate asset that adds darwin-x64 and the feature list.

/** The frozen v1 target list. Never add to it; new targets go in v2 only. */
export const LEGACY_HOST_RELEASE_TARGETS = HOST_RELEASE_TARGETS
export const HOST_RELEASE_TARGETS_V2 = [...HOST_RELEASE_TARGETS, 'darwin-x64'] as const
export type HostReleaseTargetV2 = (typeof HOST_RELEASE_TARGETS_V2)[number]

/**
 * What a Host build can do, as its v2 manifest and `phosphor version --json` report
 * it. Distinct from `apps/host`'s `HostFeature`, which is a served protocol feature.
 */
export const HOST_RELEASE_FEATURES = [
  'local-mode',
  'owner-socket',
  'owner-lock',
  'service-pause',
  'headroom',
  'app-services',
  'ops',
  'machine-grants',
  'migrate-v1',
] as const
export type HostReleaseFeature = (typeof HOST_RELEASE_FEATURES)[number]

/** On `host-latest`; with `.sig` beside it. */
export const HOST_RELEASE_MANIFEST_V2 = 'phosphor-host.manifest.v2.json'
/** On `host-<tag>` for a tag such as `v1.2.3`; with `.sig` beside it. */
export const hostReleaseManifestV2Name = (tag: string): string =>
  `phosphor-host-${tag}.manifest.v2.json`

export const HOST_RELEASE_V2_LIMITS = { artifacts: 16, features: 32 } as const

export interface HostReleaseArtifactV2 {
  target: HostReleaseTargetV2
  file: string
  bytes: number
  sha256: string
}
export interface HostReleaseManifestV2 {
  schema: 2
  version: string
  protocols: number[]
  node: string
  sourceCommit: string
  /** Every listed name, known or not; a reader checks for the ones it needs. */
  features: string[]
  /** Known targets only. */
  artifacts: HostReleaseArtifactV2[]
}

function v2Artifact(a: unknown, version: string): HostReleaseArtifactV2 | null | undefined {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return null
  const v = a as Record<string, unknown>
  const target = HOST_RELEASE_TARGETS_V2.find((t) => t === v.target)
  if (!target) return typeof v.target === 'string' ? undefined : null
  return v.file === `phosphor-host-${version}-${target}.tar.gz` &&
    typeof v.bytes === 'number' &&
    Number.isSafeInteger(v.bytes) &&
    v.bytes >= 1 &&
    v.bytes <= HOST_RELEASE_ARTIFACT_MAX_BYTES &&
    typeof v.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(v.sha256)
    ? { target, file: v.file, bytes: v.bytes, sha256: v.sha256 }
    : null
}

/** Tolerant where v1 is exact: unknown top-level and artifact keys are ignored, unknown targets skipped. */
export function parseHostReleaseManifestV2(value: unknown): HostReleaseManifestV2 | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const { protocols, features, artifacts } = v
  if (
    v.schema !== 2 ||
    typeof v.version !== 'string' ||
    !HOST_RELEASE_VERSION_PATTERN.test(v.version) ||
    typeof v.node !== 'string' ||
    !HOST_RELEASE_VERSION_PATTERN.test(v.node) ||
    typeof v.sourceCommit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(v.sourceCommit) ||
    !Array.isArray(protocols) ||
    protocols.length < 1 ||
    protocols.length > 8 ||
    !protocols.every((p): p is number => Number.isSafeInteger(p) && p >= 1 && p <= 65535) ||
    new Set(protocols).size !== protocols.length ||
    !Array.isArray(features) ||
    features.length > HOST_RELEASE_V2_LIMITS.features ||
    !features.every(
      (f): f is string => typeof f === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(f),
    ) ||
    new Set(features).size !== features.length ||
    !Array.isArray(artifacts) ||
    artifacts.length < 1 ||
    artifacts.length > HOST_RELEASE_V2_LIMITS.artifacts
  )
    return null
  const known: HostReleaseArtifactV2[] = []
  for (const a of artifacts) {
    const artifact = v2Artifact(a, v.version)
    if (artifact === null || known.some((k) => k.target === artifact?.target)) return null
    if (artifact) known.push(artifact)
  }
  return {
    schema: 2,
    version: v.version,
    protocols,
    node: v.node,
    sourceCommit: v.sourceCommit,
    features,
    artifacts: known,
  }
}
