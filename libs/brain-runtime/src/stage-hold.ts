import type { BrainEntityKind } from '@phosphor/shared/brain'
import type { StageClaim } from './stage-types'
import type { TranscriptWindow } from './windows'

/** Deterministic backstops: personal claims are not saved, temporary claims expire. */
export type ClaimHold = 'temporary' | 'personal'

const DAY = 86_400_000
/** An end this soon after the claim was said makes it a near-term plan or status. */
const NEAR_TERM_DAYS = 60
// Capitalised month names only, so "may" in a sentence is not a date.
const MONTH = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`
const ORDINAL = String.raw`(\d{1,2})(?:st|nd|rd|th)?`
/** Status words. Whole words only: "still" never matches "distillation". */
const STATUS =
  /\b(?:as of|currently|still|this week|this sprint|this quarter|for now|for the time being|temporarily)\b/i
const WEEKDAY = String.raw`(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?`
/** "until Friday", "until next tue", "until further notice": a state with its end in sight. */
const UNTIL_DAY = new RegExp(
  String.raw`\buntil\s+(?:(?:next|this)\s+)?(?:${WEEKDAY}|further notice)\b`,
  'i',
)
/** "until March", "until the end of June", "until 3 August", "until 2027-06-01", at any distance.
 * Month names are capitalised, as in dates, and must end there: "until marketing" is no month. */
const UNTIL_DATE = new RegExp(
  String.raw`\buntil\s+(?:the\s+(?:end|start|middle)\s+of\s+)?(?:${ORDINAL}\s+)?(?:${MONTH}(?![a-z])|\d{4}-\d{2}-\d{2}\b)`,
)
/** A ticket or pull request as the sentence's subject: "PR 412 …", "HBR-27 …", "#88 …". */
const TICKET_SUBJECT = [
  /^(?:the\s+)?(?:pull request|PR|ticket|issue)\s*#?\d+\b/i,
  // Keys are upper case, so a product name such as "Kestrel-2" is not a ticket.
  /^(?:#\d+|[A-Z][A-Z0-9]+-\d+)\b/,
]
/** Words before "performance" that make it a system's, not a person's: "query performance". */
const TECHNICAL = String.raw`query|queries|database|db|api|app|page|site|system|service|server|network|build|runtime|render(?:ing)?|load|cpu|gpu|memory|disk|search|index|pipeline|code|model`
/**
 * A person's performance: next to a review word, or followed within a few words by
 * expectations, a review, an improvement plan or a PIP. Never after a technical word.
 */
const PERFORMANCE = new RegExp(
  [
    String.raw`performance (?:review|reviews|rating|ratings|plan|issues?|concerns?|feedback)\b`,
    String.raw`performance\b(?:\W+\w+){0,6}?\W+(?:expectations?|reviews?|improvement plan|PIP)\b`,
  ]
    .map((rule) => String.raw`(?<!\b(?:${TECHNICAL})\s+)\b${rule}`)
    .join('|'),
  'i',
)
/** Remarks about a person beyond their role: leveling, feelings, absence. */
const PERSONAL = new RegExp(
  [
    String.raw`promot(?:ion|ions|ed|e|es|ing)`,
    String.raw`calibrat(?:ion|ed|ing)`,
    String.raw`level(?:l?ing)`,
    String.raw`(?:job|career|promotion|pay|salary) levels?`,
    String.raw`level [1-9]`,
    String.raw`L[1-9]`,
    String.raw`upset`,
    String.raw`absen(?:ce|ces|t)`,
    String.raw`(?:on|parental|sick|annual|medical|maternity|paternity|personal) leave`,
    String.raw`(?:taking|takes|took) leave`,
    String.raw`leave of absence`,
    String.raw`(?:is|was|be|are|were) away (?:from|until|on|for|in|over)`,
    String.raw`vacation`,
    String.raw`out of office`,
    String.raw`underperform\w*`,
  ]
    .map((word) => String.raw`\b${word}\b`)
    .join('|'),
  'i',
)

function nearTerm(date: number, saidAt: number): boolean {
  const start = Math.floor(saidAt / DAY) * DAY
  return date >= start && date <= saidAt + NEAR_TERM_DAYS * DAY
}
/**
 * The hold a claim's own words call for: personal for a remark about a named person beyond their
 * role, temporary for status, a near-term end or a ticket as its subject, else null.
 */
export function backstopHold(claim: {
  text: string
  namesPerson: boolean
  saidAt: number
  validFrom: number | null
  validTo: number | null
}): ClaimHold | null {
  if (claim.namesPerson && (PERSONAL.test(claim.text) || PERFORMANCE.test(claim.text)))
    return 'personal'
  if (
    STATUS.test(claim.text) ||
    UNTIL_DAY.test(claim.text) ||
    UNTIL_DATE.test(claim.text) ||
    TICKET_SUBJECT.some((subject) => subject.test(claim.text)) ||
    (claim.validTo !== null && nearTerm(claim.validTo, claim.saidAt))
  )
    return 'temporary'
  return null
}
/** The stronger of two holds: personal over temporary over none. */
export function strongerHold(a: ClaimHold | null, b: ClaimHold | null): ClaimHold | null {
  return a === 'personal' || b === 'personal' ? 'personal' : (a ?? b)
}
/** The model's hold for a claim, raised by the backstop: when it was said is its newest quote. */
export function holdClaim(
  claim: StageClaim,
  kinds: ReadonlyMap<string, BrainEntityKind>,
  window: TranscriptWindow,
): StageClaim {
  const saidAt = Math.max(
    0,
    ...claim.quotes.map((q) => window.segments[Number(q.segment.slice(1)) - 1]?.observedAt ?? 0),
  )
  const backstop = backstopHold({
    text: claim.text,
    namesPerson: claim.mentions.some((ref) => kinds.get(ref) === 'person'),
    saidAt,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
  })
  return { ...claim, hold: strongerHold(claim.hold ?? null, backstop) }
}
