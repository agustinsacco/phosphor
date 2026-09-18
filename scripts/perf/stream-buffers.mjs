// Run explicitly: node scripts/perf/stream-buffers.mjs. No model or Electron needed.
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'

async function load(path) {
  const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  })
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
}
const { JsonlDecoder } = await load('electron/pi/jsonl.ts')
const { ScrollbackBuffer } = await load('electron/pty/scrollback-buffer.ts')
const samples = 5
function measure(run) {
  run() // warmup
  const times = Array.from({ length: samples }, run).sort((a, b) => a - b)
  return { medianMs: times[2], minMs: times[0], maxMs: times[4] }
}
console.log(
  JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    samples,
  }),
)
for (const mib of [1, 4, 16]) {
  const input = Buffer.from(JSON.stringify({ text: 'x'.repeat(mib * 1024 * 1024) }) + '\n')
  const result = measure(() => {
    const decoder = new JsonlDecoder()
    const start = performance.now()
    const lines = []
    for (let i = 0; i < input.length; i += 4096) {
      lines.push(...decoder.push(input.subarray(i, i + 4096)))
    }
    lines.push(...decoder.end())
    const elapsed = performance.now() - start
    if (lines.length !== 1 || lines[0] + '\n' !== input.toString())
      throw new Error('Framing mismatch')
    return elapsed
  })
  console.log(
    JSON.stringify({ workload: 'jsonl-framing', payloadMiB: mib, chunkBytes: 4096, ...result }),
  )
}
for (const count of [10_000, 100_000]) {
  const cap = 256 * 1024
  const initial = 'x'.repeat(cap)
  const chunks = Array.from({ length: count }, (_, i) => String(i).padStart(32, '0'))
  const expected = (initial + chunks.join('')).slice(-cap)
  let snapshotMs = 0
  const result = measure(() => {
    const buffer = new ScrollbackBuffer(cap)
    buffer.append(initial)
    const start = performance.now()
    for (const chunk of chunks) buffer.append(chunk)
    const elapsed = performance.now() - start
    const attachStart = performance.now()
    const snapshot = buffer.snapshot()
    snapshotMs = performance.now() - attachStart
    if (snapshot !== expected) throw new Error('Tail mismatch')
    return elapsed
  })
  console.log(
    JSON.stringify({
      workload: 'pty-append',
      chunks: count,
      chunkCodeUnits: 32,
      ...result,
      lastSnapshotMs: snapshotMs,
    }),
  )
}
