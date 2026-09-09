import { defaultUrlTransform } from 'react-markdown'

/**
 * What a link in model-authored markdown actually points at.
 *
 * Models link three very different things in the same syntax: a web URL
 * (`https://github.com/.../pull/214`), a file they just wrote
 * (`docs/architecture.md`), and an artifact of the current
 * session (`artifact://phosphor-beacon`). Before this split, every link went to
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
  /** `artifact://<id>` — an artifact of THIS session, opened in its pane. */
  | { kind: 'artifact'; id: string; version?: number }
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
    if (scheme === 'artifact') return artifactTarget(raw.slice(scheme.length + 1))
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
 * `artifact://<id>` — the artifact the model just wrote, opened in the pane
 * beside the chat. Models were already writing this link ("hand the user the
 * link" is in the tool's own description) and every one of them was inert:
 * an unknown scheme classified as `none`, so the click did nothing at all.
 *
 * An optional `#v2` / `@v2` suffix opens a specific version, matching how the
 * tool result names one. The id is slugified the same way `pi-ext/artifacts.ts`
 * slugifies it, so a link written from the TITLE still finds the artifact.
 */
function artifactTarget(rest: string): LinkTarget {
  let body = decode(rest.replace(/^\/\//, '')).trim()
  let version: number | undefined

  const suffix = /[#@]v?(\d+)$/i.exec(body)
  if (suffix) {
    version = Number(suffix[1]) || undefined
    body = body.slice(0, suffix.index)
  }
  // Any other fragment is a heading the model carried over from a doc link;
  // slugifying it into the id would name an artifact that does not exist.
  const hash = body.indexOf('#')
  if (hash !== -1) body = body.slice(0, hash)

  const id = body
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (!id) return { kind: 'none' }
  return version === undefined ? { kind: 'artifact', id } : { kind: 'artifact', id, version }
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

/**
 * react-markdown drops any href whose protocol is not web-safe, and it does so
 * BEFORE the component sees it — `artifact://phosphor-beacon` reached
 * `MarkdownLink` as an empty string. That is what kept every artifact link in
 * chat dead: the classifier above can only act on an href that survives.
 *
 * `artifact:` is ours and cannot navigate anything — `MarkdownLink` resolves it
 * against this session's artifacts in-process and never sets an href — so let
 * it through and defer to react-markdown's own filter for every other URL.
 * `javascript:` and friends must keep being stripped there.
 */
export function artifactUrlTransform(url: string): string {
  return /^artifact:/i.test(url.trim()) ? url : defaultUrlTransform(url)
}
