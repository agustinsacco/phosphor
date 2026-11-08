import { expect, it } from 'vitest'
import {
  LANE_PART_KINDS,
  LANE_TRANSFER_LIMITS,
  isPartPath,
  parseLaneManifest,
  parseLaneMoveMarks,
} from './host-protocol-lane-transfer'
import {
  LANE_EXPORT_METHODS,
  LANE_IMPORT_METHODS,
  parseLaneTransferParams,
} from './host-protocol-lane-transfer-calls'

it('freezes the transfer method sets, kinds and resource ceilings', () => {
  expect(LANE_EXPORT_METHODS).toEqual([
    'laneTransfer.inspect',
    'laneTransfer.export',
    'laneTransfer.exportStatus',
    'laneTransfer.read',
    'laneTransfer.release',
  ])
  expect(LANE_IMPORT_METHODS).toEqual([
    'laneTransfer.check',
    'laneTransfer.begin',
    'laneTransfer.chunk',
    'laneTransfer.commit',
    'laneTransfer.importStatus',
  ])
  expect(LANE_PART_KINDS).toEqual([
    'transcript',
    'runs',
    'subagent',
    'claude-transcript',
    'claude-sidecar',
    'claude-prompt',
    'attachment',
  ])
  expect(LANE_TRANSFER_LIMITS).toEqual({
    chunkBytes: 1048576,
    bundleBytes: 268435456,
    transcriptBytes: 33554432,
    attachmentBytes: 20971520,
    parts: 4000,
    lifetimeMs: 3600000,
    messages: 16,
  })
})

it.each(['../file', '/absolute', 'a/../b', 'a//b', '.', 'a\\b', 'a/./b'])(
  'refuses unsafe part path %s',
  (path) => {
    expect(isPartPath(path)).toBe(false)
  },
)

it('strictly admits ids, offsets, canonical chunks and pin/marker metadata', () => {
  const importId = 'a'.repeat(32)
  const chunk = { importId, offset: 0, data: 'YWJj' }
  expect(parseLaneTransferParams('laneTransfer.chunk', chunk)).toEqual({
    method: 'laneTransfer.chunk',
    ...chunk,
  })
  expect(parseLaneTransferParams('laneTransfer.chunk', { ...chunk, path: '/caller' })).toBeNull()
  expect(parseLaneTransferParams('laneTransfer.chunk', { ...chunk, offset: -1 })).toBeNull()
  expect(parseLaneTransferParams('laneTransfer.chunk', { ...chunk, data: '' })).toBeNull()
  expect(
    parseLaneTransferParams('laneTransfer.chunk', { ...chunk, data: 'not-base64!' }),
  ).toBeNull()
  expect(parseLaneMoveMarks({ pinned: true, marker: '' })).toEqual({ pinned: true, marker: '' })
  expect(parseLaneMoveMarks({ pinned: true, marker: '\n' })).toBeNull()
})

it('refuses manifests with mismatched sizes, duplicate parts and unknown fields', () => {
  const sessionId = '01a1b11c-7705-7534-964e-c100db3101ce'
  const manifest = {
    version: 1,
    source: {
      sessionId,
      title: 'Keep me',
      workspace: 'notes',
      cwd: '/notes',
      git: null,
      bytes: 1,
      transcriptBytes: 1,
    },
    fileName: `2026-11-06T13-46-35-141Z_${sessionId}.jsonl`,
    modifiedAt: 0,
    claude: null,
    parts: [{ kind: 'transcript', path: '', size: 1, sha256: 'a'.repeat(64) }],
  }
  expect(parseLaneManifest(manifest)).toEqual(manifest)
  expect(
    parseLaneManifest({ ...manifest, parts: [...manifest.parts, ...manifest.parts] }),
  ).toBeNull()
  expect(parseLaneManifest({ ...manifest, source: { ...manifest.source, bytes: 2 } })).toBeNull()
  expect(parseLaneManifest({ ...manifest, destination: '/caller' })).toBeNull()
})
