import { build } from 'esbuild'
import { isBuiltin } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const result = await build({
  absWorkingDir: root,
  entryPoints: ['apps/control/src/main.ts'],
  outfile: 'apps/control/dist/server.mjs',
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  metafile: true,
})
const foreign = Object.values(result.metafile.outputs)
  .flatMap((output) => output.imports)
  .filter((entry) => !entry.path.startsWith('node:') || !isBuiltin(entry.path))
if (foreign.length) throw new Error('Control bundle has non-node imports')
await mkdir(new URL('../dist/', import.meta.url), { recursive: true })
for (const file of result.outputFiles) await writeFile(file.path, file.contents)
console.log('apps/control/dist/server.mjs built (node22, no runtime dependencies)')
