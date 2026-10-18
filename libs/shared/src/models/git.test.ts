import { expectTypeOf, it } from 'vitest'
import type {
  AddWorktreeBranch,
  BranchInfo,
  CheckoutResult,
  FetchResult,
  PullResult,
  UpdateFromMainResult,
} from './git'

it('git keeps every result discriminant and branch optionality', () => {
  expectTypeOf<AddWorktreeBranch['kind']>().toEqualTypeOf<'new' | 'existing'>()
  expectTypeOf<Extract<FetchResult, { fetched: false }>['reason']>().toEqualTypeOf<
    'throttled' | 'failed'
  >()
  expectTypeOf<Extract<PullResult, { pulled: false }>['reason']>().toEqualTypeOf<
    'up-to-date' | 'no-upstream' | 'diverged' | 'dirty'
  >()
  expectTypeOf<Extract<UpdateFromMainResult, { updated: false }>['reason']>().toEqualTypeOf<
    'up-to-date' | 'dirty' | 'conflict'
  >()
  expectTypeOf<Extract<CheckoutResult, { checkedOut: false }>['reason']>().toEqualTypeOf<
    'dirty' | 'held'
  >()
  expectTypeOf<Extract<FetchResult, { fetched: true }>>().toEqualTypeOf<{
    fetched: true
    at: number
  }>()
  expectTypeOf<Extract<PullResult, { pulled: true }>>().toEqualTypeOf<{
    pulled: true
    upstream: string
    commits: number
  }>()
  expectTypeOf<Extract<UpdateFromMainResult, { updated: true }>>().toEqualTypeOf<{
    updated: true
    commits: number
    sha: string
  }>()
  expectTypeOf<Extract<CheckoutResult, { checkedOut: true }>>().toEqualTypeOf<{
    checkedOut: true
    branch: string
  }>()
  expectTypeOf<BranchInfo>().toEqualTypeOf<{
    name: string
    isCurrent: boolean
    worktreePath?: string
    lastCommitSubject?: string
    lastCommitAt?: number
    upstream?: string
    ahead?: number
    behind?: number
    behindDefault?: number
  }>()
})
