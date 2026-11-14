import { expect, it } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import { prRouteOf, retainPrRoutes } from './prRoutes'

const A = '00000000-0000-4000-8000-0000000000aa'
const B = '00000000-0000-4000-8000-0000000000bb'
const ref = { host: 'github.com', owner: 'acme', repo: 'app', number: 7 }
const key = prKey(ref)

it('routes a PR through a Host while any of its lanes holds it, then back to This Mac', () => {
  expect(prRouteOf(key)).toBeUndefined()
  const first = retainPrRoutes(A, [ref, ref])
  const second = retainPrRoutes(A, [ref])
  expect(prRouteOf(key)).toBe(`host:${A}`)
  first()
  expect(prRouteOf(key)).toBe(`host:${A}`)
  second()
  expect(prRouteOf(key)).toBeUndefined()
})

it('keeps a PR on a Host that still holds it when another releases it', () => {
  const a = retainPrRoutes(A, [ref])
  const b = retainPrRoutes(B, [ref])
  a()
  expect(prRouteOf(key)).toBe(`host:${B}`)
  b()
  expect(prRouteOf(key)).toBeUndefined()
})
