const localArchive = {
  kind: 'unsupported',
  reason: 'Local lane archives require Desktop.',
} as const
const remote = { kind: 'remote-supported' } as const

/** Archives belong to their original machine; browsers never fall back to local disk. */
export const ARCHIVE_WEB = {
  'sessions:archive': localArchive,
  'sessions:archives': localArchive,
  'sessions:restoreArchive': localArchive,
  'sessions:purgeArchive': localArchive,
  'hosts:archiveLane': remote,
  'hosts:archives': remote,
  'hosts:restoreArchive': remote,
  'hosts:purgeArchive': remote,
}
