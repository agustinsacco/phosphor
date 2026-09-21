import { describe, expect, it } from 'vitest'
import {
  buildFeedbackIssue,
  FEEDBACK_FIELD_MAX,
  githubIssueUrl,
  isFeedbackSubmittable,
  normalizeFeedbackPrefs,
  sanitizeRelayEndpoint,
  shouldNudgeForFeedback,
  type FeedbackDraft,
} from './feedback'

const DAY = 24 * 60 * 60 * 1000

const draft = (over: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  rating: 4,
  comment: 'Lanes are great.',
  wishlist: 'Split panes.',
  anonymous: true,
  includeEnvironment: true,
  ...over,
})

describe('buildFeedbackIssue', () => {
  it('titles from the first line of the comment and labels the rating', () => {
    const issue = buildFeedbackIssue(draft({ comment: 'Lanes are great.\nSecond line.' }))
    expect(issue.title).toBe('[Feedback] 4/5 — Lanes are great.')
    expect(issue.labels).toEqual(['feedback', 'rating:4'])
  })

  it('falls back to the wishlist, then to no summary at all', () => {
    expect(buildFeedbackIssue(draft({ comment: '' })).title).toBe('[Feedback] 4/5 — Split panes.')
    expect(buildFeedbackIssue(draft({ comment: '', wishlist: '' })).title).toBe('[Feedback] 4/5')
  })

  it('never carries contact details when anonymous', () => {
    const issue = buildFeedbackIssue(draft({ anonymous: true, contact: 'me@example.com' }))
    expect(issue.body).not.toContain('me@example.com')
    expect(issue.body).toContain('Submitted anonymously.')
  })

  it('carries contact details when the user chose to be named', () => {
    const issue = buildFeedbackIssue(draft({ anonymous: false, contact: '@someone' }))
    expect(issue.body).toContain('Contact for follow-up: @someone')
  })

  it('does not claim contact details it does not have', () => {
    const issue = buildFeedbackIssue(draft({ anonymous: false, contact: '  ' }))
    expect(issue.body).toContain('Submitted without contact details.')
  })

  it('attaches the environment only when asked', () => {
    const env = { appVersion: '1.2.3', platform: 'darwin', arch: 'arm64' }
    expect(buildFeedbackIssue(draft(), env).body).toContain('Phosphor 1.2.3 · darwin arm64')
    expect(buildFeedbackIssue(draft({ includeEnvironment: false }), env).body).not.toContain(
      '1.2.3',
    )
  })

  it('clamps an overlong field', () => {
    const issue = buildFeedbackIssue(draft({ comment: 'x'.repeat(FEEDBACK_FIELD_MAX * 2) }))
    expect(issue.body).toContain('…')
    expect(issue.body.length).toBeLessThan(FEEDBACK_FIELD_MAX * 2)
  })
})

describe('githubIssueUrl', () => {
  it('prefills title, body and labels', () => {
    const url = new URL(githubIssueUrl('o/r', buildFeedbackIssue(draft())))
    expect(url.pathname).toBe('/o/r/issues/new')
    expect(url.searchParams.get('labels')).toBe('feedback,rating:4')
    expect(url.searchParams.get('body')).toContain('Split panes.')
  })

  it('fits a draft with both fields at their cap without truncating', () => {
    const maxed = buildFeedbackIssue(
      draft({ comment: 'y'.repeat(FEEDBACK_FIELD_MAX), wishlist: 'z'.repeat(FEEDBACK_FIELD_MAX) }),
    )
    const url = githubIssueUrl('o/r', maxed)
    expect(url.length).toBeLessThanOrEqual(7000)
    expect(decodeURIComponent(url)).not.toContain('truncated')
  })

  it('truncates rather than emitting a URL GitHub would reject', () => {
    // Heavily escaped text is the case the caps alone do not cover: every
    // character costs three in the query string.
    const url = githubIssueUrl('o/r', { title: 't', body: '€'.repeat(4000), labels: ['feedback'] })
    expect(url.length).toBeLessThanOrEqual(7000)
    expect(decodeURIComponent(url)).toContain('truncated')
  })
})

describe('sanitizeRelayEndpoint', () => {
  it('accepts https', () => {
    expect(sanitizeRelayEndpoint(' https://relay.example/feedback ')).toBe(
      'https://relay.example/feedback',
    )
  })

  it('rejects plaintext, other schemes, credentials and junk', () => {
    expect(sanitizeRelayEndpoint('http://relay.example')).toBeNull()
    expect(sanitizeRelayEndpoint('file:///etc/passwd')).toBeNull()
    expect(sanitizeRelayEndpoint('https://user:pw@relay.example')).toBeNull()
    expect(sanitizeRelayEndpoint('not a url')).toBeNull()
    expect(sanitizeRelayEndpoint(undefined)).toBeNull()
  })
})

describe('shouldNudgeForFeedback', () => {
  const now = 100 * DAY
  const earned = { launches: 9, firstSeenAt: now - 10 * DAY }

  it('shows once the app has been used for a few days', () => {
    expect(shouldNudgeForFeedback(normalizeFeedbackPrefs(earned), now)).toBe(true)
  })

  it('stays quiet for a fresh install', () => {
    expect(shouldNudgeForFeedback(normalizeFeedbackPrefs({ launches: 1 }), now)).toBe(false)
    expect(
      shouldNudgeForFeedback(normalizeFeedbackPrefs({ launches: 9, firstSeenAt: now }), now),
    ).toBe(false)
  })

  it('never returns after a dismissal or a submission', () => {
    expect(
      shouldNudgeForFeedback(normalizeFeedbackPrefs({ ...earned, dismissedAt: now }), now),
    ).toBe(false)
    expect(
      shouldNudgeForFeedback(normalizeFeedbackPrefs({ ...earned, submittedAt: now }), now),
    ).toBe(false)
  })
})

describe('normalizeFeedbackPrefs', () => {
  it('fills holes and drops an unusable relay', () => {
    expect(normalizeFeedbackPrefs(undefined)).toEqual({ launches: 0, relayEndpoint: undefined })
    expect(normalizeFeedbackPrefs({ launches: -3, relayEndpoint: 'http://x' })).toEqual({
      launches: 0,
      relayEndpoint: undefined,
    })
  })
})

describe('isFeedbackSubmittable', () => {
  it('needs at least one of the two answers', () => {
    expect(isFeedbackSubmittable(draft({ comment: '', wishlist: '' }))).toBe(false)
    expect(isFeedbackSubmittable(draft({ comment: '   ', wishlist: 'Panes' }))).toBe(true)
  })
})
