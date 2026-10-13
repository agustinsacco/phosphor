import { join } from 'node:path'
import { hostStateDirectory } from '../lanes/state-dir'
import { createFileLog, type RuntimeLog } from '@phosphor/session-runtime/file-log'
import { redact } from './environment'

/**
 * `${XDG_STATE_HOME:-~/.local/state}/phosphor-host/logs`, on Linux and macOS
 * alike. A relative XDG_STATE_HOME is ignored, as the XDG spec asks.
 */
export function hostLogDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return join(hostStateDirectory(env, home), 'logs')
}

export interface HostLog {
  write: RuntimeLog
  /** The same redaction, for text that leaves the Host another way. */
  hide: (text: string) => string
  /** The file in use, or null when the folder could not be made. */
  path: () => string | null
}

/**
 * The Host's log: folder 0700, files 0600, rotating at 5 MB like Desktop's.
 * Every string is redacted before it is serialized, so a secret holding a
 * quote or a newline cannot get through as its JSON escape. pi's stderr
 * arrives one line at a time, so every line of a secret that spans lines is
 * hidden on its own as well.
 */
export function createHostLog(directory: string, secrets: readonly string[]): HostLog {
  const file = createFileLog({ directory: 0o700, file: 0o600 })
  file.init(directory)
  const pieces = redactionPieces(secrets)
  const hide = (text: string): string => redact(text, pieces)
  return {
    hide,
    path: file.path,
    write: (scope, message, data) => {
      let hidden: unknown
      try {
        hidden = data === undefined ? undefined : hideStrings(data, hide)
      } catch {
        // A getter that throws: what the file log writes for data it cannot serialize.
        hidden = '[unserializable]'
      }
      file.write(scope, hide(message), hidden)
    },
  }
}

/**
 * Every secret, then each line of one that spans lines, longest first. A line
 * is hidden however short it is: split from the rest, it is all a reader
 * sees. A line of only whitespace is the one left out. It holds nothing of
 * the secret, and hiding it would hide every space in every line.
 */
export function redactionPieces(secrets: readonly string[]): string[] {
  const pieces = new Set(secrets)
  for (const secret of secrets) {
    for (const line of secret.split(/\r\n|\r|\n/)) if (/\S/.test(line)) pieces.add(line)
  }
  return [...pieces].sort((a, b) => b.length - a.length)
}

/** A copy with every string hidden. What JSON would drop stays dropped; a cycle becomes a mark. */
function hideStrings(
  value: unknown,
  hide: (text: string) => string,
  path = new Set<object>(),
): unknown {
  if (typeof value === 'string') return hide(value)
  if (typeof value !== 'object' || value === null) return value
  if (path.has(value)) return '[circular]'
  path.add(value)
  try {
    const plain = value as { toJSON?: () => unknown }
    if (typeof plain.toJSON === 'function') return hideStrings(plain.toJSON(), hide, path)
    if (Array.isArray(value)) return value.map((item) => hideStrings(item, hide, path))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hideStrings(item, hide, path)]),
    )
  } finally {
    path.delete(value)
  }
}
