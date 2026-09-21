/**
 * In-app feedback: a rating, what's working, and what the user wants next.
 *
 * GitHub issues are the database. Two ways in, and which one is live depends
 * only on whether a relay is configured — Phosphor itself never holds a token:
 *
 * - **relay** — an HTTPS endpoint that owns a GitHub token and files the issue
 *   as its own bot account. The only path that is genuinely anonymous, because
 *   the poster is the bot rather than the user.
 * - **github** (default) — Phosphor opens a prefilled `issues/new` in the
 *   browser and the user presses the green button. No secret anywhere, but the
 *   issue carries their GitHub account, so it is never anonymous. The UI says
 *   so rather than offering a checkbox that cannot keep its promise.
 *
 * Everything in this file is pure so both processes can share it and the
 * builders can be tested without a network or a window.
 */

export type FeedbackRating = 1 | 2 | 3 | 4 | 5

/** What the user filled in. Nothing is collected that is not in here. */
export interface FeedbackDraft {
  rating: FeedbackRating
  /** Honest take: what works, what doesn't. */
  comment: string
  /** Features they'd like to see. */
  wishlist: string
  /** Drop any contact detail and ask the relay to post without attribution. */
  anonymous: boolean
  /** Handle or email, only ever sent when `anonymous` is false. */
  contact?: string
  /** Attach app version and platform — non-identifying, and it triages bugs. */
  includeEnvironment: boolean
}

/** The non-identifying build facts a draft may opt into attaching. */
export interface FeedbackEnvironment {
  appVersion: string
  platform: string
  arch: string
}

/** A GitHub issue, ready for either submission path. */
export interface FeedbackIssue {
  title: string
  body: string
  labels: string[]
}

/** Persisted state behind the nudge, plus the optional relay. */
export interface FeedbackPrefs {
  /** Epoch ms Phosphor first counted a launch — the nudge waits after this. */
  firstSeenAt?: number
  /** App starts seen. The nudge needs real use, not one curious launch. */
  launches: number
  /** Epoch ms the user said no. Set once; the nudge never returns. */
  dismissedAt?: number
  /** Epoch ms feedback was last sent. */
  submittedAt?: number
  /** HTTPS relay that files the issue anonymously. Empty means browser mode. */
  relayEndpoint?: string
}

export const DEFAULT_FEEDBACK_PREFS: FeedbackPrefs = { launches: 0 }

/** Everything the renderer needs to draw the button, the nudge and the form. */
export interface FeedbackState {
  mode: 'relay' | 'github'
  /** True when the quiet sidebar nudge has earned the right to show. */
  nudge: boolean
  submittedAt?: number
  /** `owner/repo` the issue lands in. */
  repo: string
}

/** Outcome of a submit. `url` is the issue (relay) or the prefill (github). */
export type FeedbackSubmitResult =
  { ok: true; mode: 'relay' | 'github'; url?: string } | { ok: false; error: string }

/** Where feedback lands. Same repo the app ships from. */
export const FEEDBACK_REPO = 'agustinsacco/Phosphor'

/** Label every feedback issue carries, so the query is one filter. */
export const FEEDBACK_LABEL = 'feedback'

/**
 * Per-field cap. Long enough for a real paragraph, short enough that the
 * browser path stays inside GitHub's URL limit even with both fields full.
 */
export const FEEDBACK_FIELD_MAX = 2000

/** Contact is a handle or an email, not an essay. */
export const FEEDBACK_CONTACT_MAX = 120

/** Launches before the nudge is allowed to appear at all. */
const NUDGE_MIN_LAUNCHES = 5

/** And this long since the first one, so a busy first day can't trigger it. */
const NUDGE_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000

function clamp(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/** A stored prefs blob, with the holes a hand-edited config file can leave. */
export function normalizeFeedbackPrefs(raw: Partial<FeedbackPrefs> | undefined): FeedbackPrefs {
  return {
    ...DEFAULT_FEEDBACK_PREFS,
    ...raw,
    launches: Math.max(0, Math.trunc(raw?.launches ?? 0)),
    relayEndpoint: sanitizeRelayEndpoint(raw?.relayEndpoint) ?? undefined,
  }
}

/**
 * An acceptable relay URL, or null.
 *
 * HTTPS only, and no credentials in the URL: this endpoint is read from prefs,
 * so a bad value must fail closed into browser mode rather than become a
 * plaintext request carrying whatever the user typed.
 */
export function sanitizeRelayEndpoint(raw: string | undefined | null): string | null {
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.username || parsed.password) return null
  return parsed.toString()
}

/**
 * Whether to show the quiet sidebar nudge.
 *
 * Three ways to never see it again: dismiss it, send feedback, or simply not
 * use the app enough to qualify. There is no launch popup and no second ask.
 */
export function shouldNudgeForFeedback(prefs: FeedbackPrefs, now: number): boolean {
  if (prefs.dismissedAt || prefs.submittedAt) return false
  if (prefs.launches < NUDGE_MIN_LAUNCHES) return false
  if (prefs.firstSeenAt === undefined) return false
  return now - prefs.firstSeenAt >= NUDGE_MIN_AGE_MS
}

/** `★★★★☆` for 4. */
export function ratingStars(rating: FeedbackRating): string {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating)
}

/** True when the draft says enough to be worth filing. */
export function isFeedbackSubmittable(draft: FeedbackDraft): boolean {
  return draft.comment.trim().length > 0 || draft.wishlist.trim().length > 0
}

/**
 * The issue a draft becomes. Headings are fixed so the issues stay greppable
 * as a dataset, and the rating is a label as well as prose so it can be
 * filtered without parsing bodies.
 */
export function buildFeedbackIssue(
  draft: FeedbackDraft,
  environment?: FeedbackEnvironment,
): FeedbackIssue {
  const comment = clamp(draft.comment, FEEDBACK_FIELD_MAX)
  const wishlist = clamp(draft.wishlist, FEEDBACK_FIELD_MAX)
  const contact = draft.anonymous ? '' : clamp(draft.contact ?? '', FEEDBACK_CONTACT_MAX)

  const summary = clamp((comment || wishlist).split('\n')[0] ?? '', 60)
  const title = summary
    ? `[Feedback] ${draft.rating}/5 — ${summary}`
    : `[Feedback] ${draft.rating}/5`

  const lines = [`**Rating:** ${ratingStars(draft.rating)} (${draft.rating}/5)`, '']
  lines.push("### What's working, what isn't", '', comment || '_No answer._', '')
  lines.push("### Features I'd like to see", '', wishlist || '_No answer._', '')
  lines.push('---', '')
  if (draft.includeEnvironment && environment) {
    lines.push(
      `Phosphor ${environment.appVersion} · ${environment.platform} ${environment.arch}`,
      '',
    )
  }
  // Says what is actually here, not what the user picked: "with contact
  // details" over an empty contact field is a line that lies to whoever
  // triages the issue.
  if (draft.anonymous) lines.push('Submitted anonymously.')
  else if (contact) lines.push(`Contact for follow-up: ${contact}`)
  else lines.push('Submitted without contact details.')

  return {
    title,
    body: lines.join('\n'),
    labels: [FEEDBACK_LABEL, `rating:${draft.rating}`],
  }
}

/**
 * GitHub's own URL limit is generous but finite, and a rejected prefill looks
 * like a broken button. Stay well under it.
 */
const ISSUE_URL_MAX = 7000

/**
 * A prefilled `issues/new` URL. The body is truncated rather than dropped if
 * the whole thing would be too long — a shortened report still beats a 414.
 */
export function githubIssueUrl(repo: string, issue: FeedbackIssue): string {
  const build = (body: string): string => {
    const params = new URLSearchParams({
      title: issue.title,
      body,
      labels: issue.labels.join(','),
    })
    return `https://github.com/${repo}/issues/new?${params.toString()}`
  }

  if (build(issue.body).length <= ISSUE_URL_MAX) return build(issue.body)

  // Halve until it fits. Percent-escaping makes the cost per character vary by
  // 1x to 9x, so the length of the body is a poor predictor of the URL's —
  // measure instead of computing a cut.
  let body = issue.body
  for (let i = 0; i < 12 && body.length > 0; i++) {
    body = body.slice(0, Math.floor(body.length / 2))
    const url = build(`${body}\n\n_(truncated — the rest did not fit)_`)
    if (url.length <= ISSUE_URL_MAX) return url
  }
  return build('_(truncated — please paste your feedback here)_')
}
