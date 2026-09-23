/**
 * What a workspace file is, by extension — shared so the main process (which
 * serves the bytes with a content type) and the renderer (which picks a
 * viewer) can never disagree about it.
 *
 * Extension, not content sniffing, on purpose: the served content type is
 * forced from this table and sent with `nosniff`, so a file named `.pdf` that
 * is really HTML reaches the PDF viewer as a PDF, never as a document.
 */

/** A file the Files pane renders instead of (or as well as) editing as text. */
export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'html'

const MIME_TYPES: Record<string, string> = {
  // image
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  // documents
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  // What an HTML preview's relative references usually point at.
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
}

/** Lower-cased extension without the dot; '' when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  // A leading dot is a hidden file (`.env`), not an extension.
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Content type to serve a file with. Unknown types are opaque bytes. */
export function mimeTypeForPath(path: string): string {
  return MIME_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}

/** How the Files pane can render this file, or null for text/unknown. */
export function previewKindForPath(path: string): PreviewKind | null {
  const ext = extensionOf(path)
  if (ext === 'pdf') return 'pdf'
  if (ext === 'html' || ext === 'htm') return 'html'
  const mime = MIME_TYPES[ext]
  if (mime?.startsWith('image/')) return 'image'
  if (mime?.startsWith('video/')) return 'video'
  if (mime?.startsWith('audio/')) return 'audio'
  return null
}

/**
 * Previewable files that are ALSO text, so they keep a Source view in the
 * editor. Everything else previewable is opaque bytes: main does not read it
 * into memory to sniff it, and it never reaches Monaco.
 */
export function isTextPreview(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'svg' || ext === 'html' || ext === 'htm'
}
