import { useEffect, useState } from 'react'
import type { OpenFile } from '@/stores/files'

/**
 * Where a viewer reads a file's bytes: a `phosphor-file://` grant for a file on this device
 * (`local`) or one streaming a Host lane's file (`stream`), or in a browser the Host file read
 * whole into a `blob:` URL (`blob`).
 */
export type PreviewSource =
  { kind: 'local' } | { kind: 'stream'; sessionId: string } | { kind: 'blob'; sessionId: string }

/**
 * The file's preview URL, re-requested whenever it changes on disk.
 *
 * A grant is per file, not per version, so its URL is stable; the `v` query is what makes the
 * viewer reload after an agent rewrites the file. A Host reports no mtime, so its size is the
 * version, and a new size re-reads the grant. A blob URL holds one version's bytes in this
 * page: it takes no query, a new version is a new blob, and each is revoked once it is
 * replaced or the viewer closes. Only a `blob:` URL is accepted for one.
 */
export function usePreviewUrl(
  workspacePath: string,
  file: OpenFile,
  source: PreviewSource,
): { url: string | null; failed: boolean } {
  const { path, relativePath } = file
  const host = source.kind !== 'local'
  const version = host ? file.size : Math.round(file.mtimeMs)
  const regrant = host ? version : null
  const sessionId = source.kind === 'local' ? undefined : source.sessionId
  const blob = source.kind === 'blob'
  const [state, setState] = useState<{ base: string | null; failed: boolean }>({
    base: null,
    failed: false,
  })
  useEffect(() => {
    let cancelled = false
    let held: string | null = null
    setState({ base: null, failed: false })
    const grant = sessionId
      ? window.phosphor.invoke('hosts:filePreviewUrl', { sessionId, path: relativePath })
      : window.phosphor.invoke('fs:previewUrl', workspacePath, path)
    void grant
      .then((base) => {
        if (blob && base.startsWith('blob:')) {
          if (cancelled) return URL.revokeObjectURL(base)
          held = base
        } else if (blob) throw new Error('Not a blob URL')
        if (!cancelled) setState({ base, failed: false })
      })
      .catch(() => !cancelled && setState({ base: null, failed: true }))
    return () => {
      cancelled = true
      if (held) URL.revokeObjectURL(held)
    }
  }, [workspacePath, path, relativePath, sessionId, regrant, blob])
  const url = state.base && !blob ? `${state.base}?v=${version}` : state.base
  return { url, failed: state.failed }
}
