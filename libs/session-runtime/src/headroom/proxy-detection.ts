import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extractVersion } from '@phosphor/session-runtime/pi/versions'

const execFileAsync = promisify(execFile)

export interface Detection {
  binaryPath: string | null
  version: string | null
}

export interface ProxyDetectionDeps {
  resolveBinaryImpl: (name: string) => Promise<string | null>
  versionImpl: (binaryPath: string) => Promise<string | null>
}

/** Cache successful detection for five minutes and missing binaries for five seconds. */
export function createProxyDetection(deps: ProxyDetectionDeps): () => Promise<Detection> {
  let detection: { value: Detection; at: number } | null = null
  const DETECT_TTL_MS = 5 * 60_000
  /**
   * A MISS is cached too, briefly. `resolveBinary` runs a login shell, and the
   * tab calls `status()` on mount, after every button and after the install
   * job — for the common not-installed case that was a shell spawn each time.
   * Short enough that the refresh after an install (tens of seconds of
   * downloading) still sees the new binary.
   */
  const MISS_TTL_MS = 5_000

  async function detect(): Promise<Detection> {
    const ttl = detection?.value.binaryPath ? DETECT_TTL_MS : MISS_TTL_MS
    if (detection && Date.now() - detection.at < ttl) return detection.value
    const binaryPath = await deps.resolveBinaryImpl('headroom')
    const version = binaryPath ? await deps.versionImpl(binaryPath) : null
    const value = { binaryPath, version }
    detection = { value, at: Date.now() }
    return value
  }

  return detect
}

export async function headroomVersion(binaryPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, ['--version'], { timeout: 15_000 })
    return extractVersion(stdout) ?? extractVersion(stderr)
  } catch {
    return null
  }
}
