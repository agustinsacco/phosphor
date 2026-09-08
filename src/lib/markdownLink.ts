/**
 * What a link in model-authored markdown actually points at.
 *
 * Models link two very different things in the same syntax: a web URL
 * (`https://github.com/.../pull/214`) and a file they just wrote
 * (`docs/specs/headroom-compression.md`). Before this split, every link went to
 * `window.open`, which meant the file link either navigated the app away (dev,
 * where the renderer is served over http) or did nothing at all (packaged,
 * where the resolved `file://` URL is denied) — so a spec the model announced
 * was unreachable from the message announcing it.
 *
 * A link with no scheme is treated as a path, not a bare domain: models write
 * `[docs](docs/x.md)` and `[GitHub](https://github.com)`, never
 * `[GitHub](github.com)`.
 */
export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string; line?: number }
  /** In-document `#heading` — nothing to navigate to, so nothing happens. */
  | { kind: 'anchor' }
  | { kind: 'none' }

/** `mailto:`, `javascript:`, custom schemes — anything we refuse to act on. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

export function classifyLink(href: string): LinkTarget {
  const raw = href.trim()
  if (!raw) return { kind: 'none' }
  if (raw.startsWith('#')) return { kind: 'anchor' }

  const scheme = SCHEME.exec(raw)?.[1]?.toLowerCase()
  // A one-letter "scheme" is a Windows drive (`C:\repo\x.ts`), not a scheme.
  if (scheme && scheme.length > 1) {
    if (scheme === 'http' || scheme === 'https') return { kind: 'external', url: raw }
    if (scheme === 'file') {
      try {
        const url = new URL(raw)
        return filePath(url.pathname + url.hash)
      } catch {
        return { kind: 'none' }
      }
    }
    return { kind: 'none' }
  }
  return filePath(raw)
}

/**
 * Split a path from the line it points at. Both conventions models use are
 * accepted: GitHub's `path#L42` and the compiler/grep `path:42` (and
 * `path:42:7`, whose column is dropped — the editor reveals lines).
 */
function filePath(value: string): LinkTarget {
  let path = value
  let line: number | undefined

  const hash = path.indexOf('#')
  if (hash !== -1) {
    line = Number(/^L(\d+)/i.exec(path.slice(hash + 1))?.[1]) || undefined
    path = path.slice(0, hash)
  }

  const trailing = /:(\d+)(?::\d+)?$/.exec(path)
  if (trailing) {
    line ??= Number(trailing[1]) || undefined
    path = path.slice(0, trailing.index)
  }

  path = decode(path).replace(/^\.\//, '')
  if (!path || path === '.') return { kind: 'none' }
  return line === undefined ? { kind: 'file', path } : { kind: 'file', path, line }
}

/** Percent-decoding is best effort: a stray `%` is a literal in a path. */
function decode(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}
