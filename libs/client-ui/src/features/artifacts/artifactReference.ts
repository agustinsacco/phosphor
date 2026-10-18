/**
 * The text "Copy reference" puts on the clipboard, for pasting into a prompt.
 *
 * It is the ref the artifacts extension already resolves
 * (`parseArtifactRef` in `libs/pi-extensions/pi-ext/artifact-store.ts`):
 * `artifact://<piSessionId>/<slug>`, plus `#vN` when the reader is on an older
 * version. `artifact_read` treats a ref to its own session as local and any
 * other as a read-only read from the store, so the same text works in the lane
 * that made the artifact and in any other lane on the same machine.
 *
 * The session id is pi's own (the session file's), not Phosphor's live-session
 * key: that is the id the store indexes by. Null until it is known.
 */
export function artifactReference(
  piSessionId: string | undefined,
  slug: string,
  version?: number,
): string | null {
  if (!piSessionId) return null
  const base = `artifact://${piSessionId}/${slug}`
  return version == null ? base : `${base}#v${version}`
}
