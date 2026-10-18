import { describe, it, expect } from 'vitest'
import { parseErrorMessage } from './errorMessage'

// The exact string from the report that started this: an Anthropic envelope
// forwarded verbatim, with the one readable sentence buried mid-JSON.
const ANTHROPIC_EXTRA_USAGE =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CeDMeGVDtzbJ44qpikt1U"}'

describe('parseErrorMessage', () => {
  it('unwraps an Anthropic envelope, keeping the status, type and request id', () => {
    const parsed = parseErrorMessage(ANTHROPIC_EXTRA_USAGE)
    expect(parsed.text).toBe(
      'Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.',
    )
    expect(parsed.status).toBe(400)
    expect(parsed.type).toBe('invalid_request_error')
    expect(parsed.requestId).toBe('req_011CeDMeGVDtzbJ44qpikt1U')
    expect(parsed.unwrapped).toBe(true)
  })

  it('unwraps an OpenAI-shaped envelope with no status prefix', () => {
    const parsed = parseErrorMessage(
      '{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":null}}',
    )
    expect(parsed.text).toBe('You exceeded your current quota.')
    expect(parsed.type).toBe('insufficient_quota')
    expect(parsed.status).toBeUndefined()
    expect(parsed.unwrapped).toBe(true)
  })

  it('handles an error field that is itself a string', () => {
    const parsed = parseErrorMessage('502 {"error":"upstream connect error"}')
    expect(parsed.text).toBe('upstream connect error')
    expect(parsed.status).toBe(502)
  })

  it('prefers a top-level message over a nested one', () => {
    const parsed = parseErrorMessage('{"message":"summary","error":{"message":"detail"}}')
    expect(parsed.text).toBe('summary')
  })

  it('leaves plain-text errors exactly as they are', () => {
    const raw = "Validation error: data retention mode 'default' is not available for this model."
    const parsed = parseErrorMessage(raw)
    expect(parsed.text).toBe(raw)
    expect(parsed.unwrapped).toBe(false)
  })

  it('falls back to the raw string when the JSON is truncated', () => {
    const raw = '400 {"type":"error","error":{"message":"cut off here'
    expect(parseErrorMessage(raw)).toMatchObject({ text: raw, unwrapped: false })
  })

  it('falls back to the raw string when the JSON carries no sentence', () => {
    const raw = '429 {"type":"error","error":{"code":42}}'
    expect(parseErrorMessage(raw)).toMatchObject({ text: raw, unwrapped: false, status: 429 })
  })

  it('does not report a bare JSON string as unwrapped', () => {
    // Nothing was hidden, so there is no raw worth keeping behind a toggle.
    expect(parseErrorMessage('{"message":"boom"}').unwrapped).toBe(true)
    expect(parseErrorMessage('boom').unwrapped).toBe(false)
  })

  it('gives a sentence for an empty or missing message', () => {
    expect(parseErrorMessage(undefined).text).toBe('The model request failed.')
    expect(parseErrorMessage('   ').text).toBe('The model request failed.')
  })
})
