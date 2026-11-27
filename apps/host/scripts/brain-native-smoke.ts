import type * as OnnxRuntime from 'onnxruntime-node'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BRAIN_EMBEDDING_WORKER, BRAIN_WORKER_DIR } from '../src/brain/packaged-runtime'

/** A tiny, generated ONNX protobuf: opset 13 Identity, float[1] x -> y. */
function identityModel() {
  const value = (n: number, v: number) => [n << 3, v]
  const field = (n: number, bytes: number[]) => [(n << 3) | 2, bytes.length, ...bytes]
  const string = (n: number, text: string) => field(n, [...Buffer.from(text)])
  const info = (name: string) => [
    ...string(1, name),
    ...field(2, field(1, [...value(1, 1), ...field(2, field(1, value(1, 1)))])),
  ]
  const node = [...string(1, 'x'), ...string(2, 'y'), ...string(4, 'Identity')]
  const graph = [
    ...field(1, node),
    ...string(2, 'Harbor'),
    ...field(11, info('x')),
    ...field(12, info('y')),
  ]
  return Uint8Array.from([...value(1, 8), ...field(7, graph), ...field(8, value(2, 13))])
}

export async function syntheticInference(dir: string) {
  // Load the actual Node ESM entry (including native Sharp), then exercise ORT's
  // CPU provider directly. The tiny fixture does not pretend to be EmbeddingGemma.
  await import(
    pathToFileURL(join(dir, 'node_modules/brain-transformers/dist/transformers.node.mjs')).href
  )
  const require = createRequire(join(dir, BRAIN_WORKER_DIR, BRAIN_EMBEDDING_WORKER))
  const ort = require('onnxruntime-node') as typeof OnnxRuntime
  const session = await ort.InferenceSession.create(identityModel(), {
    executionProviders: ['cpu'],
  })
  try {
    const result = await session.run({ x: new ort.Tensor('float32', Float32Array.of(13), [1]) })
    assert.deepEqual(Array.from(result.y!.data as Float32Array), [13])
  } finally {
    await session.release()
  }
}
