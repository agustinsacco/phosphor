/**
 * `/phosphor-prs pin|hide|clear <pull request url>`: Track or Hide a pull
 * request in this lane. Loaded by context-breakdown.ts.
 *
 * The choice moves with the lane, so it is a custom entry in the lane's own
 * session file, written by the one process that owns that file. The session
 * scan folds it back (`LANE_PR_ENTRY` in
 * `libs/session-runtime/src/pi/lane-pr-signals.ts`). A custom entry is never
 * part of the model's context, and the command runs no turn.
 *
 * pi runs an extension command at once, even mid-turn: the entry joins the
 * branch between the turn's messages, which is harmless because the model
 * never sees custom entries.
 *
 * Self-contained because pi loads this file outside Phosphor's module graph:
 * the URL check mirrors `parsePrUrl` and `isPrRef` in
 * `libs/shared/src/github-pr-refs.ts` (pinned by `lane-prs.test.ts`).
 */

export const LANE_PRS_COMMAND = 'phosphor-prs'
/** The custom entry type. Same spelling as the command. */
export const LANE_PRS_ENTRY = 'phosphor-prs'

export type LanePrsAction = 'pin' | 'hide' | 'clear'

export interface LanePrsRef {
  host: string
  owner: string
  repo: string
  number: number
}

export interface LanePrsEntry {
  action: LanePrsAction
  ref: LanePrsRef
}

const ACTIONS: readonly string[] = ['pin', 'hide', 'clear']
const HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/
const PR_URL =
  /^https:\/\/([a-z0-9.-]+)\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([\w.-]{1,100})\/pull\/(\d{1,9})(?:[/?#][^\s]*)?$/i

/** One pull request URL on any host, or null. */
export function parseLanePrUrl(text: string): LanePrsRef | null {
  const match = PR_URL.exec(text)
  if (!match) return null
  const ref = {
    host: match[1]!.toLowerCase(),
    owner: match[2]!,
    repo: match[3]!,
    number: Number(match[4]),
  }
  const valid = HOST.test(ref.host) && ref.repo !== '.' && ref.repo !== '..' && ref.number > 0
  return valid ? ref : null
}

/** `pin <url>`, `hide <url>` or `clear <url>`; throws a message fit for the transcript. */
export function parseLanePrsArgs(args: string): LanePrsEntry {
  const [action, url, ...rest] = args.trim().split(/\s+/)
  if (!action || !ACTIONS.includes(action) || !url || rest.length > 0)
    throw new Error('Expected /phosphor-prs pin, hide or clear, then one pull request URL.')
  const ref = parseLanePrUrl(url)
  if (!ref) throw new Error(`Not a pull request URL: ${url}`)
  return { action: action as LanePrsAction, ref }
}

interface LanePrsApi {
  appendEntry?(type: string, data: unknown): void
  registerCommand?(
    name: string,
    command: { description: string; handler(args: string, ctx: unknown): Promise<void> },
  ): void
}

export default function lanePrs(pi: LanePrsApi): void {
  pi.registerCommand?.(LANE_PRS_COMMAND, {
    description: 'Host control: track or hide a pull request in this lane without running a model',
    async handler(args) {
      const entry = parseLanePrsArgs(args)
      if (!pi.appendEntry) throw new Error('This Pi version cannot persist lane pull requests.')
      pi.appendEntry(LANE_PRS_ENTRY, { action: entry.action, ref: entry.ref })
    },
  })
}
