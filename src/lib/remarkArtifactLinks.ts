/**
 * Turn an `artifact://<id>` URL that is NOT a markdown link into one.
 *
 * Models reference an artifact three ways in the same message, and only the
 * first was ever clickable:
 *
 * 1. `[Preview the design](artifact://phosphor-beacon)` — a real link.
 * 2. `` `artifact://phosphor-beacon` `` — inline code, because the URL reads
 *    like an identifier. This is the FORM MODELS USE MOST: on-disk sessions
 *    hold more backticked artifact URLs than linked ones (a checklist line
 *    like "Delivered companion artifact **X**: `artifact://x`").
 * 3. A bare `artifact://phosphor-beacon` in prose. GFM autolinks www/http/
 *    mailto only, so our scheme stays plain text there.
 *
 * Forms 2 and 3 rendered as dead text: the message announced an artifact and
 * gave no way to open it. This plugin rewrites both into link nodes, so they
 * reach `MarkdownLink` and `classifyLink` like any other artifact link — the
 * inline-code one keeps its `<code>` child, so it still looks like code and
 * merely becomes clickable.
 *
 * A version suffix (`#v2` / `@v2`) is part of the URL, since `classifyLink`
 * reads it. Trailing punctuation is not: a sentence ending in
 * `artifact://x.` must link `artifact://x`, because the id is slugified and
 * `x.` would name an artifact that does not exist.
 */

/** The subset of mdast this walker touches; structural, so no mdast dep. */
interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/**
 * Ids are the slug `pi-ext/artifacts.ts` writes (`[a-z0-9-]`, no leading or
 * trailing hyphen), plus the optional version suffix `classifyLink` accepts.
 */
const ARTIFACT_URL = /artifact:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:[#@]v?\d+)?/gi

export function remarkArtifactLinks(): (tree: unknown) => void {
  return (tree) => linkify(tree as MdNode)
}

function linkify(node: MdNode): void {
  const children = node.children
  if (!children) return
  // Inside an existing link there is nothing to promote, and wrapping a link
  // in a link would produce invalid markup.
  if (node.type === 'link' || node.type === 'linkReference') return

  const next: MdNode[] = []
  let changed = false

  for (const child of children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      const split = splitText(child.value)
      if (split) {
        next.push(...split)
        changed = true
        continue
      }
    } else if (child.type === 'inlineCode' && typeof child.value === 'string') {
      // Only a code span that is EXACTLY one URL: `run artifact://x` is prose
      // about a command, not a link.
      const url = wholeUrl(child.value)
      if (url) {
        next.push({ type: 'link', url, children: [child] })
        changed = true
        continue
      }
    }
    linkify(child)
    next.push(child)
  }

  if (changed) node.children = next
}

/** Null when the text holds no artifact URL, so untouched nodes stay identical. */
function splitText(value: string): MdNode[] | null {
  ARTIFACT_URL.lastIndex = 0
  if (!ARTIFACT_URL.test(value)) return null

  const out: MdNode[] = []
  let last = 0
  ARTIFACT_URL.lastIndex = 0
  for (let match = ARTIFACT_URL.exec(value); match; match = ARTIFACT_URL.exec(value)) {
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) })
    out.push({ type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] })
    last = match.index + match[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function wholeUrl(value: string): string | null {
  const trimmed = value.trim()
  ARTIFACT_URL.lastIndex = 0
  const match = ARTIFACT_URL.exec(trimmed)
  return match && match[0] === trimmed ? trimmed : null
}
