import { describe, expect, it } from 'vitest'
import {
  CONTROL_ERROR_STATUS,
  isControlErrorCode,
  machineStatus,
  parseControlError,
  parseHealthResponse,
} from '../control-api'

const SEEN = '2026-10-12T10:05:00.000Z'
const seenMs = Date.parse(SEEN)

describe('health, errors and status through the control-api entry', () => {
  it('reads health replies with a bounded version, ok first', () => {
    const health = { ok: true, version: 'v'.repeat(100), configured: false }
    expect(parseHealthResponse({ ...health, extra: 1 })).toStrictEqual({ ok: true, value: health })
    for (const value of [null, [], {}, { ...health, ok: 'true' }, { ...health, ok: 1 }])
      expect(parseHealthResponse(value)).toStrictEqual({ ok: false, reason: 'ok' })
    for (const version of ['v'.repeat(101), 1, null])
      expect(parseHealthResponse({ ...health, version, configured: 'x' })).toStrictEqual({
        ok: false,
        reason: 'version',
      })
    for (const configured of ['true', 1, null, undefined])
      expect(parseHealthResponse({ ...health, configured })).toStrictEqual({
        ok: false,
        reason: 'configured',
      })
  })

  it('takes only the table’s own error codes', () => {
    for (const code of Object.keys(CONTROL_ERROR_STATUS))
      expect(isControlErrorCode(code)).toBe(true)
    for (const code of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
      'Gone',
      '',
      410,
      null,
    ])
      expect(isControlErrorCode(code)).toBe(false)
  })

  it('reads error bodies, keeps known fields and caps the message at 300 units', () => {
    expect(parseControlError({ error: { code: 'conflict', message: '' } })).toStrictEqual({
      error: { code: 'conflict', message: '' },
    })
    const long = `${'x'.repeat(299)}🐝tail`
    const capped = parseControlError({ error: { code: 'internal', message: long } })
    expect(capped?.error.message).toBe(long.slice(0, 300))
    expect(capped?.error.message).toHaveLength(300)
    expect(
      parseControlError({ error: { code: 'gone', message: 'x'.repeat(300) } })?.error.message,
    ).toBe('x'.repeat(300))
    for (const value of [
      null,
      'gone',
      { error: null },
      { error: [] },
      { error: { code: 'gone' } },
      { error: { code: 'teapot', message: 'm' } },
      { error: { code: '__proto__', message: 'm' } },
      { error: { code: 'gone', message: { text: 'm' } } },
      { code: 'gone', message: 'm' },
    ])
      expect(parseControlError(value)).toBeNull()
  })

  it('is up through ninety seconds after a running beat, then down', () => {
    const running = { lastSeenAt: SEEN, state: 'running' as const }
    expect(machineStatus(running, seenMs)).toBe('up')
    expect(machineStatus(running, seenMs - 3_600_000)).toBe('up')
    expect(machineStatus(running, seenMs + 90_000)).toBe('up')
    expect(machineStatus(running, seenMs + 90_001)).toBe('down')
    expect(machineStatus(running, seenMs + 90_001, -1)).toBe('up')
    expect(machineStatus(running, seenMs + 90_000, 1)).toBe('down')
  })

  it('treats a never-seen machine first, then any state but running as down', () => {
    expect(machineStatus({ lastSeenAt: null, state: 'running' }, seenMs)).toBe('never-seen')
    expect(machineStatus({ lastSeenAt: null, state: null }, seenMs)).toBe('never-seen')
    expect(machineStatus({ lastSeenAt: SEEN, state: 'stopping' }, seenMs)).toBe('down')
    expect(machineStatus({ lastSeenAt: SEEN, state: null }, seenMs)).toBe('down')
  })
})
