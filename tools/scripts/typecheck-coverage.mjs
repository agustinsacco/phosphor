import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const typecheckProjects = [
  'apps/desktop/tsconfig.node.json',
  'apps/desktop/tsconfig.web.json',
  'apps/desktop/tsconfig.tests.json',
  'apps/desktop/tsconfig.e2e.json',
  'libs/client-ui/tsconfig.json',
  'libs/host-client/tsconfig.json',
  'libs/host-client/tsconfig.tests.json',
  'apps/web/tsconfig.json',
  'apps/web/tsconfig.tests.json',
  'apps/web/tsconfig.worker.json',
  'apps/web/e2e/tsconfig.json',
  'libs/shared/tsconfig.json',
  'libs/session-runtime/tsconfig.json',
  'libs/pi-extensions/tsconfig.json',
  'apps/host/tsconfig.json',
  'apps/control/tsconfig.json',
  'tsconfig.tools.json',
  'apps/site/tsconfig.json',
]

/** Refuse missing tools and links into another checkout's mutable installation. */
export function localTool(root, path) {
  const installation = join(realpathSync(root), 'node_modules')
  try {
    const actualInstallation = realpathSync(installation)
    if (actualInstallation !== installation) throw new Error('linked node_modules')
    const file = realpathSync(join(installation, path))
    const within = relative(installation, file)
    if (within.startsWith('..') || isAbsolute(within)) throw new Error('external tool')
    return file
  } catch (cause) {
    throw new Error(
      `${root} requires a local installation (${path}); run npm ci in that directory`,
      { cause },
    )
  }
}

function projectFiles(root, project) {
  const compiler =
    project === 'apps/site/tsconfig.json'
      ? createRequire(import.meta.url)(
          localTool(join(root, 'apps/site'), 'typescript/lib/typescript.js'),
        )
      : ts
  const fail = (diagnostic) => {
    throw new Error(
      `${project}: ${compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    )
  }
  const parsed = compiler.getParsedCommandLineOfConfigFile(
    resolve(root, project),
    {},
    {
      ...compiler.sys,
      onUnRecoverableConfigFileDiagnostic: fail,
    },
  )
  if (!parsed) throw new Error(`Cannot parse ${project}`)
  if (parsed.errors.length) fail(parsed.errors[0])
  return parsed.fileNames
}

/** Compare compiler root files, not emitted files: every project uses noEmit. */
export function auditCoverage(root, projects = typecheckProjects) {
  root = realpathSync(root)
  const covered = new Set(
    projects.flatMap((project) => projectFiles(root, project)).map((file) => resolve(file)),
  )
  const candidates = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter((file) => /\.(?:tsx?|mts|cts)$/.test(file) && existsSync(join(root, file)))
  // No generated declarations are exempt today. A tracked declaration is source
  // unless a future exemption names that exact generated file and its reason.
  return [...new Set(candidates)].filter((file) => !covered.has(resolve(root, file))).sort()
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    const missing = auditCoverage(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
    if (missing.length)
      throw new Error(`TypeScript files without a typecheck project:\n${missing.join('\n')}`)
    console.log('Typecheck coverage: all tracked and candidate TypeScript files covered')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
