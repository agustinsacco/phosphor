import type { SessionMeta, SessionScanStatus } from '@shared/models'

export type DiskScan =
  { path: string; status: 'ok'; metas: SessionMeta[] } | { path: string; status: 'error' }

/**
 * One workspace's sessions on disk. A failure is a result that still names its
 * `path`, so a batch can record status per workspace (allSettled's `reason`
 * would not say which workspace failed).
 */
export async function scanWorkspace(path: string): Promise<DiskScan> {
  try {
    return { path, status: 'ok', metas: await window.phosphor.invoke('sessions:list', path) }
  } catch {
    return { path, status: 'error' }
  }
}

/**
 * Folds scans into the sidebar's catalogue. A failed scan keeps that
 * workspace's previous sessions and records the failure, so the sidebar can
 * offer a retry instead of a permanent fake "Loading…". A deleted workspace
 * scans as ok with no sessions.
 */
export function applyDiskScans(
  state: { disk: Record<string, SessionMeta[]>; scanStatus: Record<string, SessionScanStatus> },
  scans: DiskScan[],
): { disk: Record<string, SessionMeta[]>; scanStatus: Record<string, SessionScanStatus> } {
  const disk = { ...state.disk }
  const scanStatus = { ...state.scanStatus }
  for (const scan of scans) {
    if (scan.status === 'ok') disk[scan.path] = scan.metas
    scanStatus[scan.path] = scan.status
  }
  return { disk, scanStatus }
}
