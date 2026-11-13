import { expect, it, vi } from 'vitest'
import type { FeatureContext } from '../feature'

const { branches, status, detail } = vi.hoisted(() => ({
  branches: vi.fn((_ports: unknown) => ({ read: vi.fn(), remove: vi.fn() })),
  status: vi.fn((_ports: unknown) => ({ read: vi.fn() })),
  detail: vi.fn((_ports: unknown) => ({ read: vi.fn() })),
}))
vi.mock('@phosphor/session-runtime/git/github-reader', () => ({ createGithubReader: branches }))
vi.mock('@phosphor/session-runtime/git/github-pr-status', () => ({
  createGithubPrStatusReader: status,
}))
vi.mock('@phosphor/session-runtime/git/github-pr-detail', () => ({
  createGithubPrDetailReader: detail,
}))
import { GithubGate } from '@phosphor/session-runtime/git/github-gate'
import { createGitFeature } from '../git'

const context = {
  store: { getLane: () => null, listRepositories: () => [] },
  env: {},
  home: '/host/home',
  log: vi.fn(),
} as FeatureContext

it('gives branch discovery, PR status and PR detail one gate per Host', () => {
  createGitFeature(context)
  const gate = (branches.mock.calls[0]![0] as { gate: unknown }).gate
  expect(gate).toBeInstanceOf(GithubGate)
  expect(status).toHaveBeenCalledWith({ gate, cwd: '/host/home' })
  expect(detail).toHaveBeenCalledWith({ gate, cwd: '/host/home' })
})
