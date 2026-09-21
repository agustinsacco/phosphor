import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeedbackDraft, FeedbackPrefs } from '@shared/feedback'
import { DEFAULT_FEEDBACK_PREFS } from '@shared/feedback'

const openExternal = vi.fn(async (_url: string) => {})
vi.mock('electron', () => ({
  app: { getVersion: () => '9.9.9' },
  shell: { openExternal },
}))
vi.mock('../debug-log', () => ({ log: vi.fn() }))

let stored: FeedbackPrefs = { ...DEFAULT_FEEDBACK_PREFS }
vi.mock('../store', () => ({
  getFeedbackPrefs: () => stored,
  patchFeedbackPrefs: (patch: Partial<FeedbackPrefs>) => {
    stored = { ...stored, ...patch }
    return stored
  },
}))

const { feedbackState, recordAppLaunch, submitFeedback } = await import('./feedback-service')

const draft = (over: Partial<FeedbackDraft> = {}): FeedbackDraft => ({
  rating: 5,
  comment: 'Fast.',
  wishlist: '',
  anonymous: true,
  includeEnvironment: true,
  ...over,
})

beforeEach(() => {
  stored = { ...DEFAULT_FEEDBACK_PREFS }
  delete process.env.PHOSPHOR_FEEDBACK_ENDPOINT
  openExternal.mockClear()
  vi.unstubAllGlobals()
})

describe('recordAppLaunch', () => {
  it('counts starts and stamps the first one only', () => {
    recordAppLaunch()
    const first = stored.firstSeenAt
    recordAppLaunch()
    expect(stored.launches).toBe(2)
    expect(stored.firstSeenAt).toBe(first)
  })
})

describe('feedbackState', () => {
  it('reads browser mode with no relay, relay mode with one', () => {
    expect(feedbackState().mode).toBe('github')
    stored = { ...stored, relayEndpoint: 'https://relay.example/x' }
    expect(feedbackState().mode).toBe('relay')
  })

  it('ignores a relay that is not https', () => {
    stored = { ...stored, relayEndpoint: 'http://relay.example/x' }
    expect(feedbackState().mode).toBe('github')
  })
})

describe('submitFeedback', () => {
  it('opens a prefilled GitHub issue when there is no relay', async () => {
    const result = await submitFeedback(draft())
    expect(result).toMatchObject({ ok: true, mode: 'github' })
    const opened = openExternal.mock.calls[0]?.[0] ?? ''
    expect(opened).toContain('github.com/agustinsacco/Phosphor/issues/new')
    expect(decodeURIComponent(opened)).toContain('Fast.')
    expect(stored.submittedAt).toBeTypeOf('number')
  })

  it('posts to the relay instead, and never opens a browser', async () => {
    process.env.PHOSPHOR_FEEDBACK_ENDPOINT = 'https://relay.example/feedback'
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: 'https://github.com/o/r/issues/7' }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await submitFeedback(draft())
    expect(result).toEqual({ ok: true, mode: 'relay', url: 'https://github.com/o/r/issues/7' })
    expect(openExternal).not.toHaveBeenCalled()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://relay.example/feedback')
    expect(init.credentials).toBe('omit')
    expect(JSON.parse(String(init.body))).toMatchObject({ rating: 5, anonymous: true })
  })

  it('reports a refusal without marking the feedback as sent', async () => {
    process.env.PHOSPHOR_FEEDBACK_ENDPOINT = 'https://relay.example/feedback'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503 })),
    )
    expect(await submitFeedback(draft())).toEqual({
      ok: false,
      error: 'The feedback service answered 503.',
    })
    expect(stored.submittedAt).toBeUndefined()
  })

  it('reports a network failure the same way', async () => {
    process.env.PHOSPHOR_FEEDBACK_ENDPOINT = 'https://relay.example/feedback'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ETIMEDOUT')
      }),
    )
    const result = await submitFeedback(draft())
    expect(result.ok).toBe(false)
    expect(stored.submittedAt).toBeUndefined()
  })

  it('drops a relay-returned URL that is not http(s)', async () => {
    process.env.PHOSPHOR_FEEDBACK_ENDPOINT = 'https://relay.example/feedback'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ url: 'file:///etc/passwd' }) })),
    )
    expect(await submitFeedback(draft())).toEqual({ ok: true, mode: 'relay', url: undefined })
  })
})
