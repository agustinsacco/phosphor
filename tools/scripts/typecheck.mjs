import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditCoverage, localTool, typecheckProjects } from './typecheck-coverage.mjs'

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // Only a .cmd shim needs cmd.exe (Node 22 refuses it otherwise). A shell
    // would join node's own path and arguments unquoted, which breaks on spaces.
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

export function runTypecheck(root, run = runCommand) {
  root = resolve(root)
  // TypeScript 7, the native compiler: about 7x faster than 6 on these
  // projects. `typescript` stays at 6 for the tools that need its JS API
  // (typescript-eslint, the coverage audit, size budgets).
  const compiler = localTool(root, 'typescript-native/lib/tsc.js')
  const site = join(root, 'apps/site')
  // npm adds ancestor .bin directories to PATH. Require the site's own tools
  // first so a missing site install cannot silently use the root toolchain.
  localTool(site, 'typescript/lib/typescript.js')
  localTool(site, '@astrojs/check/package.json')
  localTool(site, '.bin/astro')
  for (const project of typecheckProjects) {
    if (project === 'apps/site/tsconfig.json') continue
    const status = run(process.execPath, [compiler, '--noEmit', '-p', project], root)
    if (status !== 0) return status
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check'], site)
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
    const missing = auditCoverage(root)
    if (missing.length)
      throw new Error(`TypeScript files without a typecheck project:\n${missing.join('\n')}`)
    process.exitCode = runTypecheck(root)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
