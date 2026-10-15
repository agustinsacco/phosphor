import { expect, it } from 'vitest'
import { parseProviderLoginOp } from './host-protocol-providers'
import { parseClientFrame } from './host-protocol'

it('allows only a bounded provider id, never process options', () => {
  expect(parseProviderLoginOp({ type: 'provider.login', provider: 'xai' })).toEqual({
    type: 'provider.login',
    provider: 'xai',
  })
  expect(parseProviderLoginOp({ type: 'provider.login', provider: 'a'.repeat(64) })).not.toBeNull()
  for (const provider of ['', 'a'.repeat(65), '../x', 'a b', 'a\n', '/bin/sh'])
    expect(parseProviderLoginOp({ type: 'provider.login', provider })).toBeNull()
  for (const key of ['file', 'args', 'argv', 'env', 'cwd', 'path'])
    expect(
      parseProviderLoginOp({ type: 'provider.login', provider: 'xai', [key]: 'untrusted' }),
    ).toBeNull()
})
it('admits machine-only receipt commands, never a lane or fence', () => {
  const frame = {
    type: 'command',
    requestId: 'e4143046-0df8-45cc-ba91-2b0c4fc8b644',
    op: { type: 'provider.login', provider: 'claude' },
  }
  expect(parseClientFrame(JSON.stringify(frame)).ok).toBe(true)
  for (const extra of [{ laneId: frame.requestId }, { fence: 1 }])
    expect(parseClientFrame(JSON.stringify({ ...frame, ...extra })).ok).toBe(false)
})
