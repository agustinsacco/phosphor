import { describe, expect, it } from 'vitest'
import { HOST_FRAMES } from '../test/__fixtures__/protocol-freeze'
import {
  PAGED_LANES_LIMITS,
  PAGED_LANE_OPS,
  parseFolderListPage,
  parseLaneListPage,
} from './host-protocol-paged-lanes'
import { isOpName } from './host-protocol-ops'

const [summary] = HOST_FRAMES.lanes.lanes.lanes
const [folder] = HOST_FRAMES.lanes.lanes.repositories

describe('paged folder and lane lists', () => {
  it('names catalog ops', () => {
    for (const op of Object.values(PAGED_LANE_OPS)) expect(isOpName(op), op).toBe(true)
  })

  it('reads pages with and without a next token', () => {
    expect(parseLaneListPage({ lanes: [summary], next: 'p2' })).toStrictEqual({
      lanes: [summary],
      next: 'p2',
    })
    expect(parseFolderListPage({ folders: [folder], next: null })).toStrictEqual({
      folders: [folder],
      next: null,
    })
  })

  it('refuses oversized pages, bad tokens and invalid items', () => {
    const lanes = Array.from({ length: PAGED_LANES_LIMITS.lanesPerPage + 1 }, () => summary)
    expect(parseLaneListPage({ lanes, next: null })).toBeNull()
    expect(parseLaneListPage({ lanes: [summary] })).toBeNull()
    expect(parseLaneListPage({ lanes: [summary], next: 'a b' })).toBeNull()
    expect(parseFolderListPage({ folders: [{ id: 'x' }], next: null })).toBeNull()
  })
})
