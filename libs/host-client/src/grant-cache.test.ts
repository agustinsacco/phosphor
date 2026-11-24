import { expect, it, vi } from 'vitest'
import { createGrantCache } from './grant-cache'

it.each(['target', 'all'])('a stale %s clear cannot erase a replacement flight', async (scope) => {
  const answers: Array<(value: string) => void> = []
  const issue = vi.fn(() => new Promise<string>((resolve) => answers.push(resolve)))
  const cache = createGrantCache({
    issue,
    present: () => true,
    now: () => 0,
    readGrant: (_host, value) => ({ value, expiresAt: new Date(300_000).toISOString() }),
  })
  const old = cache.grantFor('host')
  cache.clear(scope === 'target' ? 'host' : undefined)
  const next = cache.grantFor('host')
  answers[0]!('old')
  await expect(old).rejects.toThrow('signed-out')
  expect(cache.grantFor('host')).toBe(next)
  answers[1]!('new')
  const grant = await next
  expect(grant.value).toBe('new')
  expect(await cache.grantFor('host')).toBe(grant)
  expect(issue).toHaveBeenCalledTimes(2)
})
