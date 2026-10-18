import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

it('bundles every public runtime entry for browsers without external or Node code', async () => {
  const manifest = JSON.parse(await readFile('libs/host-client/package.json', 'utf8'))
  const result = await build({
    entryPoints: Object.keys(manifest.exports).map(
      (key) => `@phosphor/host-client/${key.slice(2)}`,
    ),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    outdir: '/unused',
    metafile: true,
  })
  for (const output of Object.values(result.metafile!.outputs)) expect(output.imports).toEqual([])
  for (const input of Object.keys(result.metafile!.inputs)) {
    expect(input).not.toMatch(/session-runtime|apps\/|node:|\.test\./)
  }
  for (const file of result.outputFiles)
    expect(file.text).not.toMatch(/\bBuffer\b|\bprocess\.|node:|electron/)
})
