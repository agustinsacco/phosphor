import { app, shell } from 'electron'
import {
  buildFeedbackIssue,
  FEEDBACK_REPO,
  type FeedbackDraft,
  type FeedbackPrefs,
  type FeedbackState,
  type FeedbackSubmitResult,
  githubIssueUrl,
  sanitizeRelayEndpoint,
  shouldNudgeForFeedback,
} from '@shared/feedback'
import { externalUrl } from '../external-links'
import { getFeedbackPrefs, patchFeedbackPrefs } from '../store'
import { log } from '../debug-log'

/**
 * Filing a feedback issue, from the only process allowed to touch the network.
 *
 * Phosphor holds no GitHub credential and never will — see the header of
 * `shared/feedback.ts` for the two paths and why only the relay can be
 * anonymous.
 */

/** A relay must answer quickly; feedback is not worth a hung dialog. */
const RELAY_TIMEOUT_MS = 10_000

/**
 * The configured relay, preferring the environment so a self-hosted build can
 * point at its own without shipping a different config.
 */
function relayEndpoint(prefs: FeedbackPrefs): string | null {
  return (
    sanitizeRelayEndpoint(process.env.PHOSPHOR_FEEDBACK_ENDPOINT) ??
    sanitizeRelayEndpoint(prefs.relayEndpoint)
  )
}

/** Count this app start. Called once, from `app.whenReady()`. */
export function recordAppLaunch(): void {
  const prefs = getFeedbackPrefs()
  patchFeedbackPrefs({
    launches: prefs.launches + 1,
    firstSeenAt: prefs.firstSeenAt ?? Date.now(),
  })
}

/** What the renderer needs to decide what, if anything, to draw. */
export function feedbackState(): FeedbackState {
  const prefs = getFeedbackPrefs()
  return {
    mode: relayEndpoint(prefs) ? 'relay' : 'github',
    nudge: shouldNudgeForFeedback(prefs, Date.now()),
    submittedAt: prefs.submittedAt,
    repo: FEEDBACK_REPO,
  }
}

/** The user said "not now". Recorded once; the nudge does not come back. */
export function dismissFeedbackNudge(): void {
  patchFeedbackPrefs({ dismissedAt: Date.now() })
}

/** Non-identifying build facts, attached only when the draft opts in. */
function environment(): { appVersion: string; platform: string; arch: string } {
  return { appVersion: app.getVersion(), platform: process.platform, arch: process.arch }
}

/**
 * File the feedback.
 *
 * With a relay: POST and let it create the issue under its own identity, which
 * is what makes anonymous mean anonymous. Without one: open a prefilled
 * `issues/new` and let the user press the button. Either way the payload is
 * exactly what `buildFeedbackIssue` produced — nothing is collected here.
 */
export async function submitFeedback(draft: FeedbackDraft): Promise<FeedbackSubmitResult> {
  const issue = buildFeedbackIssue(draft, draft.includeEnvironment ? environment() : undefined)
  const endpoint = relayEndpoint(getFeedbackPrefs())

  if (!endpoint) {
    // Back through the shared policy rather than straight to openExternal: the
    // URL is built here, but the rule about what may leave the app is one rule.
    const url = externalUrl(githubIssueUrl(FEEDBACK_REPO, issue))
    if (!url) return { ok: false, error: 'Could not build the GitHub issue link.' }
    await shell.openExternal(url)
    patchFeedbackPrefs({ submittedAt: Date.now() })
    return { ok: true, mode: 'github', url }
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...issue, rating: draft.rating, anonymous: draft.anonymous }),
      // No cookies or auth ride along, and a slow relay fails rather than hangs.
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    })
    if (!response.ok) {
      log('feedback', `relay refused with ${response.status}`)
      return { ok: false, error: `The feedback service answered ${response.status}.` }
    }
    // A relay may answer with the issue it created. Anything else is fine too.
    const payload = (await response.json().catch(() => null)) as { url?: unknown } | null
    const url =
      typeof payload?.url === 'string' ? (externalUrl(payload.url) ?? undefined) : undefined
    patchFeedbackPrefs({ submittedAt: Date.now() })
    return { ok: true, mode: 'relay', url }
  } catch (error) {
    log('feedback', `relay failed: ${String(error)}`)
    return { ok: false, error: 'Could not reach the feedback service. Please try again later.' }
  }
}
