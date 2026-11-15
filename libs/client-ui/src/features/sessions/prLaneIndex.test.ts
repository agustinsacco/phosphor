import { expect, it } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { LanePrSignals } from '@shared/models'
import { prRef } from './__fixtures__/pullRequests'
import { prLaneIndex, type PrLaneFile, type PrLaneIndexInput } from './prLaneIndex'

const signals = (patch: Partial<LanePrSignals>): LanePrSignals => ({
  opened: [],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
  ...patch,
})
const meta = (path: string, patch: Partial<PrLaneFile>): PrLaneFile => ({
  path,
  cwd: '/repo',
  mtimeMs: 0,
  ...patch,
})
const input = (disk: PrLaneIndexInput['disk'], patch: Partial<PrLaneIndexInput> = {}) => ({
  disk,
  live: {},
  gitByCwd: {},
  byRepo: {},
  status: {},
  ...patch,
})

it('indexes the PRs a lane owns, never its suggestions', () => {
  const index = prLaneIndex(
    input({
      '/repo': [
        meta('/s/a.jsonl', {
          name: 'Refactor auth module',
          pullRequests: signals({
            opened: [prRef(57)],
            pinned: [prRef(70)],
            reviewing: [prRef(55)],
            mentioned: [prRef(61)],
          }),
        }),
      ],
    }),
  )
  expect([...index.keys()].sort()).toEqual([prKey(prRef(57)), prKey(prRef(70))].sort())
  expect(index.get(prKey(prRef(57)))).toMatchObject({
    path: '/s/a.jsonl',
    workspacePath: '/repo',
    title: 'Refactor auth module',
    sessionId: undefined,
  })
})

it('gives a shared PR to the lane touched last, named by its live name when running', () => {
  const opened = signals({ opened: [prRef(57)] })
  const index = prLaneIndex(
    input(
      {
        '/repo': [
          meta('/s/old.jsonl', { name: 'Old', mtimeMs: 1, pullRequests: opened }),
          meta('/s/new.jsonl', { name: 'Scanned', mtimeMs: 2, pullRequests: opened }),
        ],
      },
      {
        live: { p1: { phosphorId: 'p1', diskPath: '/s/new.jsonl' } },
        liveNames: new Map([['p1', 'Renamed']]),
      },
    ),
  )
  expect(index.get(prKey(prRef(57)))).toMatchObject({
    path: '/s/new.jsonl',
    title: 'Renamed',
    sessionId: 'p1',
  })
})

it('leaves out a PR the lane hid', () => {
  const index = prLaneIndex(
    input({
      '/repo': [
        meta('/s/a.jsonl', {
          pullRequests: signals({ opened: [prRef(57)], hidden: [prRef(57)] }),
        }),
      ],
    }),
  )
  expect(index.size).toBe(0)
})
