/**
 * The `latest-mac.yml` manifest: which release zip a Mac fetches and the
 * sha512 it must match. Text parsing only, no I/O; `mac-installer.ts`
 * re-exports it for its callers.
 */

export interface MacManifestFile {
  url: string
  sha512: string
  size: number
}

export interface MacManifest {
  version: string
  files: MacManifestFile[]
}

/**
 * Parse `latest-mac.yml` without a YAML dependency.
 *
 * The manifest is a fixed two-level shape electron-builder generates, so a
 * line reader is enough — but it MUST distinguish the per-file `sha512:` from
 * the top-level one that follows the list, or every file inherits the last
 * value. Indentation is the only signal, so it is the one this leans on: a
 * key at column 0 ends the `files:` block.
 */
export function parseMacManifest(body: string): MacManifest | null {
  let version = ''
  const files: MacManifestFile[] = []
  let inFiles = false
  let current: Partial<MacManifestFile> | null = null

  const flush = (): void => {
    if (current?.url && current.sha512) {
      files.push({ url: current.url, sha512: current.sha512, size: Number(current.size ?? 0) })
    }
    current = null
  }

  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.trim()) continue

    // A key at column 0 closes any list that was open.
    if (!/^\s/.test(line)) {
      flush()
      inFiles = false
      const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
      if (!top) continue
      if (top[1] === 'version') version = unquote(top[2] ?? '')
      else if (top[1] === 'files') inFiles = true
      continue
    }
    if (!inFiles) continue

    const item = /^\s*-\s*(.*)$/.exec(line)
    if (item) {
      flush()
      current = {}
      applyField(current, item[1] ?? '')
      continue
    }
    if (current) applyField(current, line.trim())
  }
  flush()

  if (!version || files.length === 0) return null
  return { version, files }
}

function applyField(target: Partial<MacManifestFile>, text: string): void {
  const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(text)
  if (!field) return
  const value = unquote(field[2] ?? '')
  if (field[1] === 'url') target.url = value
  else if (field[1] === 'sha512') target.sha512 = value
  else if (field[1] === 'size') target.size = Number(value)
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && /^(['"]).*\1$/.test(trimmed)) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * The zip built for this machine.
 *
 * electron-builder names the Intel zip `-mac.zip` and the Apple-silicon one
 * `-arm64-mac.zip`, so "does it contain -arm64-" is the whole test — but the
 * x64 match has to EXCLUDE that substring, otherwise an arm64 Mac handed the
 * first matching entry gets the Intel build (the manifest lists x64 first, and
 * its top-level `path:` points there too).
 */
export function pickMacZip(files: MacManifestFile[], arch: string): MacManifestFile | null {
  const zips = files.filter((file) => file.url.endsWith('.zip'))
  const arm = zips.find((file) => file.url.includes('-arm64-mac.'))
  if (arch === 'arm64') return arm ?? null
  return zips.find((file) => !file.url.includes('-arm64-')) ?? null
}
