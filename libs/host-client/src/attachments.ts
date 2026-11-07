import { base64ToBytes, bytesToBase64 } from '@phosphor/shared/base64'
import {
  ATTACHMENT_LIMITS as LIMIT,
  attachmentBase64,
  parseAttachmentOp,
  parseAttachmentResult,
  type AttachmentOp,
} from '@phosphor/shared/host-protocol-attachments'
import type { WriteLane } from './ports'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { sha256Hex } from './crypto'

/** Never retry a receipt operation, including an unknown chunk outcome. */
export async function uploadAttachments(input: unknown, lane: WriteLane): Promise<string[]> {
  if (!Array.isArray(input) || input.length > LIMIT.files) throw new Error(REMOTE_UNAVAILABLE)
  const files: {
    begin: Extract<AttachmentOp, { type: 'attachments.begin' }>
    bytes: Uint8Array<ArrayBuffer>
  }[] = []
  let total = 0
  for (const file of input) {
    if (
      typeof file !== 'object' ||
      file === null ||
      Object.keys(file).length !== 3 ||
      !('name' in file) ||
      !('mime' in file) ||
      !('data' in file) ||
      !attachmentBase64(file.data, LIMIT.fileBytes)
    )
      throw new Error(REMOTE_UNAVAILABLE)
    const bytes = base64ToBytes(file.data)
    total += bytes.length
    if (total > LIMIT.hourlyBytes) throw new Error(REMOTE_UNAVAILABLE)
    const begin = parseAttachmentOp({
      type: 'attachments.begin',
      name: file.name,
      mime: file.mime,
      size: bytes.length,
    })
    if (!begin || begin.type !== 'attachments.begin') throw new Error(REMOTE_UNAVAILABLE)
    files.push({ begin, bytes })
  }
  const paths: string[] = []
  for (const { begin, bytes } of files) {
    const result = parseAttachmentResult(await lane.write(begin))
    if (!result || !('uploadId' in result)) throw new Error(REMOTE_UNAVAILABLE)
    for (let offset = 0, index = 0; offset < bytes.length; offset += LIMIT.chunkBytes, index++) {
      const data = await lane.write({
        type: 'attachments.chunk',
        uploadId: result.uploadId,
        index,
        data: bytesToBase64(bytes.subarray(offset, offset + LIMIT.chunkBytes)),
      })
      if (data !== undefined) throw new Error(REMOTE_UNAVAILABLE)
    }
    const committed = parseAttachmentResult(
      await lane.write({
        type: 'attachments.commit',
        uploadId: result.uploadId,
        sha256: await sha256Hex(bytes),
      }),
    )
    if (!committed || !('path' in committed)) throw new Error(REMOTE_UNAVAILABLE)
    paths.push(committed.path)
  }
  return paths
}
