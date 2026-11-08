import { createHash } from 'node:crypto'
import type { ModelFile } from '@phosphor/session-runtime/model-download'

/**
 * Imports nothing from the module under test, so a `vi.mock` factory for the
 * manifest can load it without a cycle back into the mocked module.
 */
/** Small stand-ins for the pinned files, with real hashes of their content. */
export const SMALL_CONTENT: Record<string, Buffer> = {
  'config.json': Buffer.from('{"model_type":"gemma3_text"}'),
  'tokenizer.json': Buffer.from('tokenizer '.repeat(300)),
  'onnx/model_q4.onnx_data': Buffer.from('weights '.repeat(500)),
}

export const SMALL_FILES: ModelFile[] = Object.entries(SMALL_CONTENT).map(([path, data]) => ({
  path,
  url: `https://models.test/${path}`,
  sha256: createHash('sha256').update(data).digest('hex'),
  bytes: data.length,
}))

export const SMALL_TOTAL = SMALL_FILES.reduce((sum, file) => sum + file.bytes, 0)
