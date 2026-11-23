import { remoteLaneKey } from '@phosphor/shared/remote-host'

export type MentionTarget = { hostId: string; laneId: string } | { piSessionId: string }
const scheme = 'phosphor-lane:'

/** Only opaque IDs ever travel in a message, not window-local handles or file paths. */
export function laneHref(target: MentionTarget): string {
  return (
    scheme +
    ('hostId' in target
      ? remoteLaneKey(target.hostId, target.laneId)
      : `local/session:${target.piSessionId}`)
  )
}

export function parseLaneHref(url: string): MentionTarget | null {
  if (!url.startsWith(scheme)) return null
  const ref = url.slice(scheme.length)
  const host = /^host:([\w-]{1,256})\/lane:([\w-]{1,256})$/.exec(ref)
  if (host) return { hostId: host[1]!, laneId: host[2]! }
  const local = /^local\/session:([\w-]{1,256})$/.exec(ref)
  return local ? { piSessionId: local[1]! } : null
}

export function laneMentionText(title: string, href: string): string {
  // A title is plain text, even when it contains the end of a link or markup.
  const label = title.replace(/\s+/g, ' ').replace(/[\\[\]*_`~<&!$]/g, '\\$&')
  return `[@${label}](${href})`
}
