import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { buildBrainExtensions } from './build-brain-extensions.mjs'

it('stages standalone working and processor extensions with no workspace dependency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brain-resource-'))
  try {
    const extensions = join(root, 'libs/pi-extensions/pi-ext')
    const client = join(root, 'libs/brain-client/src')
    const outDir = join(root, 'resources/brain-ext')
    await mkdir(extensions, { recursive: true })
    await mkdir(client, { recursive: true })
    await writeFile(join(client, 'client.ts'), 'export const value = 42\n')
    for (const file of ['brain', 'brain-processor'])
      await writeFile(
        join(extensions, `${file}.ts`),
        "import {value} from '@phosphor/brain-client/client'; export default () => value\n",
      )
    await buildBrainExtensions({ root, outDir })
    // Simulate an installed app: the entire source tree is now absent.
    await rm(join(root, 'libs'), { recursive: true })
    for (const file of ['brain', 'brain-processor']) {
      const output = join(outDir, `${file}.mjs`)
      const code = await readFile(output, 'utf8')
      expect(code).not.toContain(root)
      expect(code).not.toContain('@phosphor/')
      expect(code).not.toContain('sourceMappingURL')
      const result = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const m = await import(${JSON.stringify(pathToFileURL(output).href)}); console.log(m.default())`,
        ],
        { encoding: 'utf8' },
      )
      expect(result.trim()).toBe('42')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
