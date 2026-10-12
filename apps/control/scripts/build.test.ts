import { expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

it('rejects non-node-prefixed bundle imports before publishing output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phosphor-control-build-'))
  const app = join(root, 'apps/control')
  const script = join(app, 'scripts/build.mjs')
  const main = join(app, 'src/main.ts')
  try {
    await mkdir(join(app, 'scripts'), { recursive: true })
    await mkdir(join(app, 'src'))
    const source = await readFile(new URL('./build.mjs', import.meta.url), 'utf8')
    await writeFile(
      script,
      source.replace(
        "from 'esbuild'",
        `from '${createRequire(import.meta.url).resolve('esbuild')}'`,
      ),
    )
    await writeFile(main, "import { isBuiltin } from 'module'; console.log(isBuiltin('node:fs'))")
    expect(() => execFileSync(process.execPath, [script], { stdio: 'pipe' })).toThrow(
      'Control bundle has non-node imports',
    )
    await expect(readFile(join(app, 'dist/server.mjs'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(
      main,
      "import { isBuiltin } from 'node:module'; console.log(isBuiltin('node:fs'))",
    )
    execFileSync(process.execPath, [script], { stdio: 'pipe' })
    expect(await readFile(join(app, 'dist/server.mjs'), 'utf8')).toContain('node:module')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
