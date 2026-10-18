/** Content carried inside client command ops: prompt images and extension UI answers. */
import type { ExtensionUIResponse, ImageContent } from '../rpc'
import { HOST_LIMITS } from './constants'
import { frameId, member, record, text } from './primitives'

function imageData(v: unknown): v is string {
  // Avoid a repeated-group regex: multi-megabyte images can exhaust the regex stack.
  if (!text(v, HOST_LIMITS.inboundFrameBytes) || v.length % 4 !== 0) return false
  const unpadded = v.endsWith('==') ? v.slice(0, -2) : v.endsWith('=') ? v.slice(0, -1) : v
  return /^[A-Za-z0-9+/]+$/.test(unpadded)
}

/** Up to sixteen images, each projected to its own fields; null when any is invalid. */
export function parsePromptImages(v: unknown): ImageContent[] | null {
  if (!Array.isArray(v) || v.length > 16) return null
  const out: ImageContent[] = []
  for (const item of v) {
    if (
      !record(item) ||
      item.type !== 'image' ||
      !imageData(item.data) ||
      !member(item.mimeType, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    )
      return null
    out.push({ type: 'image', data: item.data, mimeType: item.mimeType })
  }
  return out
}

/** Exactly one answer: a string value, a boolean confirmation, or cancelled true. */
export function parseExtensionUiResponse(v: unknown): ExtensionUIResponse | null {
  if (!record(v) || v.type !== 'extension_ui_response' || !frameId(v.id)) return null
  const count = ['value', 'confirmed', 'cancelled'].filter((k) => k in v).length
  if (count !== 1) return null
  if (typeof v.value === 'string') return { type: v.type, id: v.id, value: v.value }
  if (typeof v.confirmed === 'boolean') return { type: v.type, id: v.id, confirmed: v.confirmed }
  return v.cancelled === true ? { type: v.type, id: v.id, cancelled: true } : null
}
