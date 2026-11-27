import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// Only the runtime paths reached by the Node export, and their upstream notices.
// No postinstall helpers, bundled platform alternatives, duplicate dylibs or WASM assets.
const PACKAGE_FILES = {
  '@huggingface/transformers': ['dist/transformers.node.mjs', 'LICENSE'],
  '@huggingface/tokenizers': ['LICENSE'],
  '@huggingface/jinja': ['LICENSE'],
  'onnxruntime-common': ['dist'],
  'onnxruntime-node': [
    'dist',
    'bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
    'bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
  ],
  sharp: ['dist', 'LICENSE'],
  'sharp/node_modules/semver': [
    'index.js',
    'classes',
    'functions',
    'internal',
    'ranges',
    'LICENSE',
  ],
  'detect-libc': ['lib', 'LICENSE'],
  '@img/colour': ['index.cjs', 'color.cjs', 'LICENSE.md'],
  '@img/sharp-darwin-arm64': ['index.cjs', 'lib', 'LICENSE'],
  '@img/sharp-libvips-darwin-arm64': [
    'lib/index.js',
    'lib/libvips-cpp.8.18.7.dylib',
    'versions.json',
    'README.md',
  ],
}

function stageEntry(source, dest) {
  const item = lstatSync(source)
  if (item.isDirectory()) {
    mkdirSync(dest, { recursive: true })
    for (const child of readdirSync(source).sort()) {
      if (!/\.(?:map|ts)$/.test(child)) stageEntry(join(source, child), join(dest, child))
    }
  } else {
    if (!item.isFile()) throw new Error('Host Brain package contains a non-regular entry')
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(source, dest)
  }
}

// The installer and updater only accept archive-safe paths. Node loads these
// aliases from this bundle; Sharp's dylib already has the required relative rpath.
export const TRANSFORMERS_PACKAGE = 'brain-transformers'
const RELOCATED = new Map([
  ['@huggingface/transformers', TRANSFORMERS_PACKAGE],
  ['@huggingface/jinja', 'brain-jinja'],
  ['@huggingface/tokenizers', 'brain-tokenizers'],
  ['@img/colour', 'sharp-colour'],
  ['@img/sharp-darwin-arm64', 'sharp-darwin-arm64'],
  ['@img/sharp-libvips-darwin-arm64', 'sharp-libvips-darwin-arm64'],
])

function relocateImport(root, path, before, after) {
  const file = join(root, path)
  const source = readFileSync(file, 'utf8')
  if (source.split(before).length !== 2 || source.includes(after))
    throw new Error(`Unexpected Host Brain native loader: ${path}`)
  writeFileSync(file, source.replace(before, after))
}

export function stageBrainDependencies(dir, root) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages
  for (const [name, files] of Object.entries(PACKAGE_FILES)) {
    const path = `node_modules/${name}`
    const source = join(root, path)
    const dest = join(dir, 'node_modules', RELOCATED.get(name) ?? name)
    if (name !== 'sharp/node_modules/semver' && existsSync(dest))
      throw new Error(`Host Brain package collision: ${name}`)
    const installed = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    if (
      !lock[path]?.integrity ||
      installed.version !== lock[path].version ||
      ((name === 'sharp' || name === '@img/sharp-darwin-arm64') && installed.version !== '0.35.5')
    )
      throw new Error(`Host Brain dependency is not lockfile-pinned: ${name}`)
    for (const file of ['package.json', ...files]) stageEntry(join(source, file), join(dest, file))
  }
  const modules = join(dir, 'node_modules')
  relocateImport(modules, 'sharp/dist/colour.mjs', "from '@img/colour'", "from 'sharp-colour'")
  relocateImport(
    modules,
    'sharp/dist/sharp.mjs',
    'require("@img/sharp-darwin-arm64/sharp.node")',
    'require("sharp-darwin-arm64/sharp.node")',
  )
  relocateImport(
    modules,
    'sharp-darwin-arm64/index.cjs',
    "require.resolve('@img/sharp-libvips-darwin-arm64/binary')",
    "require.resolve('sharp-libvips-darwin-arm64/binary')",
  )
  stageEntry(
    join(root, 'apps/host/scripts/brain-third-party-notices.md'),
    join(dir, 'brain-workers/THIRD-PARTY-NOTICES.md'),
  )
}
