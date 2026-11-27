import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { brainQualification, packagedNodeVersion } from '../../brain/packaged-runtime'

export const brainPackageFixture = [
  'brain-workers/brain-search-worker.js',
  'brain-workers/brain-embedding-worker.js',
  'brain-workers/package.json',
  'brain-ext/brain.mjs',
  'brain-ext/brain-curator.mjs',
  'brain-ext/brain-fork-guard.mjs',
  'brain-ext/brain-agent-guard.mjs',
  'skills/brain/SKILL.md',
  'node_modules/brain-transformers/dist/transformers.node.mjs',
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
  'node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
  'node_modules/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node',
  'node_modules/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
]
  .map((name) => ({ name: `lib/${name}`, text: '' }))
  .concat({
    name: 'lib/brain-workers/QUALIFIED.json',
    text: `${JSON.stringify(brainQualification('darwin-arm64'))}\n`,
  })

/** Exercises only the marker/file/Node contract, never loads a worker or models. */
export function syntheticBrainBundle(folder: string): void {
  for (const { name, text } of brainPackageFixture) {
    const file = join(folder, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const node = join(folder, 'node/bin/node')
  writeFileSync(
    node,
    `#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] && echo ${packagedNodeVersion}\n`,
  )
  chmodSync(node, 0o755)
}
