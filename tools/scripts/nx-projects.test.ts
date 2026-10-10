import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const projects = {
  desktop: 'apps/desktop',
  host: 'apps/host',
  runtime: 'libs/session-runtime',
  shared: 'libs/shared',
  'pi-extensions': 'libs/pi-extensions',
  site: 'apps/site',
  schema: 'supabase',
  tooling: 'tools/scripts',
}
const commands = {
  desktop: { build: 'npm run build', 'test:e2e': 'npm run test:e2e' },
  host: {
    typecheck: 'tsc --noEmit -p apps/host/tsconfig.json',
    test: 'vitest run apps/host',
    build: 'node apps/host/scripts/build.mjs',
  },
  runtime: { test: 'vitest run libs/session-runtime' },
  shared: { test: 'vitest run libs/shared' },
  'pi-extensions': { test: 'vitest run libs/pi-extensions' },
  site: {
    dev: 'npm run dev',
    start: 'npm run start',
    prebuild: 'npm run prebuild',
    build: 'npm run build',
    check: 'npm run check',
    preview: 'npm run preview',
    shots: 'npm run shots',
    'shots:guides': 'npm run shots:guides',
    'audit:links': 'npm run audit:links',
    test: 'npm test',
    format: 'npm run format',
  },
  schema: {
    start: 'npx --yes supabase@2.119.0 start',
    stop: 'npx --yes supabase@2.119.0 stop --no-backup',
    test: 'npx --yes supabase@2.119.0 test db',
  },
  tooling: {
    typecheck:
      'tsc --noEmit -p apps/desktop/tsconfig.node.json && tsc --noEmit -p apps/desktop/tsconfig.web.json && tsc --noEmit -p apps/host/tsconfig.json',
    lint: 'eslint .',
    test: 'vitest run',
    validate: './tools/scripts/validate.sh',
    'format-check': 'prettier --check .',
    'test:graph': 'vitest run tools/scripts/nx-projects.test.ts',
  },
}
// These edges include non-import resources and test-only consumers, not just
// production imports. No library depends on Desktop, and targets never recurse.
// The Host depends on the libraries and copies pi-ext/, exactly as Desktop does,
// and nothing depends on it except the whole-workspace checks.
// Nothing depends on `tooling` (the whole-workspace checks) and the site depends
// on nothing: its image is built from apps/site alone, and its screenshots are
// captured by hand and committed. Otherwise every change affects every app and
// per-app releases/deploys are impossible.
const dependencies = {
  desktop: ['runtime', 'shared', 'pi-extensions'],
  host: ['runtime', 'shared', 'pi-extensions'],
  runtime: ['shared', 'pi-extensions'],
  shared: [],
  'pi-extensions': ['shared'],
  site: [],
  schema: [],
  tooling: ['desktop', 'host', 'runtime', 'shared', 'pi-extensions', 'site', 'schema'],
}
// Workspace-wide checks read everything. Everything else reads its own root,
// its dependencies, and the specific root files it actually consumes.
const inputs: Record<string, Record<string, string[]>> = {
  desktop: {
    build: ['default', '^default', 'rootInstall', 'release'],
    'test:e2e': ['default', '^default', 'rootInstall', 'release', 'e2eHarness'],
  },
  host: {
    typecheck: ['default', '^default', 'rootInstall'],
    test: ['default', '^default', 'rootUnitRunner'],
    build: ['default', '^default', 'rootInstall'],
  },
  runtime: { '*': ['default', '^default', 'rootUnitRunner'] },
  shared: { '*': ['default', '^default', 'rootUnitRunner'] },
  'pi-extensions': { '*': ['default', '^default', 'rootUnitRunner'] },
  site: { build: ['default', 'deploy'], '*': ['default'] },
  schema: { '*': ['default', '{workspaceRoot}/package.json'] },
  tooling: { '*': ['workspace'] },
}
const assertEdges = (name: keyof typeof dependencies, edges: string[]) =>
  expect([...new Set(edges)].sort()).toEqual([...dependencies[name]].sort())
const assertTargets = (name: keyof typeof commands, targets: Record<string, unknown>) =>
  expect(Object.keys(targets).sort()).toEqual(Object.keys(commands[name]).sort())
const nx = (...args: string[]) =>
  execFileSync(process.execPath, [join(root, 'node_modules/nx/dist/bin/nx.js'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
  })

function readGraph() {
  const dir = mkdtempSync(join(tmpdir(), 'phosphor-nx-graph-'))
  try {
    nx('graph', `--file=${join(dir, 'graph.json')}`)
    return JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8')).graph
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('explicit Nx project contract', () => {
  // One graph process returns effective targets too. Spawning a process for
  // every project makes this suite CPU-bound during the full unit run.
  let graph: ReturnType<typeof readGraph>
  beforeAll(() => {
    graph = readGraph()
  })
  it('exercises the security overrides through Nx dependency resolution without network access', async () => {
    const require = createRequire(import.meta.url)
    const nxRequire = createRequire(require.resolve('nx/package.json'))
    expect(readJson('package.json').overrides).toEqual({
      'nx@23.2.1': { axios: '1.20.0', 'brace-expansion': '5.0.12', 'smol-toml': '1.9.0' },
    })
    const axios = nxRequire('axios')
    expect(axios.VERSION).toBe('1.20.0')
    expect(axios.getUri({ url: '/graph', params: { project: 'desktop' } })).toBe(
      '/graph?project=desktop',
    )
    const response = await axios.get('/graph', {
      adapter: async () => ({
        data: 'local',
        status: 200,
        statusText: 'OK',
        headers: {},
        config: {},
      }),
    })
    expect(response.data).toBe('local')
    expect(nxRequire('brace-expansion').expand('{runtime,shared}/**/*.test.ts')).toEqual([
      'runtime/**/*.test.ts',
      'shared/**/*.test.ts',
    ])
    const toml = nxRequire('smol-toml')
    const parsed = toml.parse('[project]\nname = "runtime"\n')
    expect(parsed).toEqual({ project: { name: 'runtime' } })
    expect(toml.parse(toml.stringify(parsed))).toEqual(parsed)
  })
  it('retains exactly eight current-path projects and all import/resource/test edges', () => {
    expect(Object.keys(graph.nodes).sort()).toEqual(Object.keys(projects).sort())
    for (const [name, path] of Object.entries(projects)) {
      expect(graph.nodes[name].data.root).toBe(path)
      const edges = graph.dependencies[name].map((edge: { target: string }) => edge.target)
      assertEdges(name as keyof typeof dependencies, edges)
    }
  })

  it('retains manifest-derived static and explicit implicit runtime dependencies', () => {
    const edges = graph.dependencies.runtime.filter(
      (edge: { target: string }) => edge.target === 'shared',
    )
    expect(edges.map((edge: { type: string }) => edge.type).sort()).toEqual(['implicit', 'static'])
    const config = readJson('libs/session-runtime/project.json')
    const explicitWithoutShared = config.implicitDependencies.filter(
      (edge: string) => edge !== 'shared',
    )
    // Static reachability cannot replace the required explicit ownership contract.
    const staticTargets = edges
      .filter((edge: { type: string }) => edge.type === 'static')
      .map((edge: { target: string }) => edge.target)
    assertEdges('runtime', [...explicitWithoutShared, ...staticTargets])
    expect(() => assertEdges('runtime', explicitWithoutShared)).toThrow()
  })

  it('keeps all targets uncached, nonrecursive and equivalent with bounded unit workers', () => {
    for (const [name, expected] of Object.entries(commands)) {
      const project = graph.nodes[name].data
      assertTargets(name as keyof typeof commands, project.targets)
      for (const [target, command] of Object.entries(expected)) {
        expect(project.targets[target]).toMatchObject({
          executor: 'nx:run-commands',
          cache: false,
          inputs:
            inputs[name as keyof typeof inputs][target] ?? inputs[name as keyof typeof inputs]['*'],
          options: {
            command,
            cwd: name === 'site' ? 'apps/site' : name === 'desktop' ? 'apps/desktop' : '.',
          },
        })
        expect(project.targets[target].dependsOn ?? []).toEqual([])
        if (name === 'tooling' && ['lint', 'typecheck'].includes(target)) {
          expect(project.targets[target].outputs).toEqual([])
        }
        if (command.startsWith('vitest run')) {
          expect(project.targets[target].options.env).toEqual({ VITEST_MAX_WORKERS: '2' })
        }
      }
    }
  })

  it('rejects missing edge fixtures, including the extension test edge to shared', () => {
    for (const [name, edges] of Object.entries(dependencies)) {
      const config = readJson(join(projects[name as keyof typeof projects], 'project.json'))
      for (const edge of edges) {
        const removed = config.implicitDependencies.filter((value: string) => value !== edge)
        expect(removed).not.toContain(edge)
        expect(config.implicitDependencies).toContain(edge)
        expect(() => assertEdges(name as keyof typeof dependencies, removed)).toThrow()
      }
    }
    const gateTest = readFileSync(
      join(root, 'libs/pi-extensions/pi-ext/optional/permission-gate.test.ts'),
      'utf8',
    )
    expect(gateTest).toContain("from '@phosphor/shared/command-approval'")
    expect(gateTest).not.toContain('apps/desktop')
    expect(readFileSync(join(root, 'apps/desktop/electron-builder.yml'), 'utf8')).toContain(
      'from: ../../libs/pi-extensions/pi-ext',
    )
    expect(
      readFileSync(join(root, 'libs/session-runtime/src/bundled-extensions.test.ts'), 'utf8'),
    ).toContain("join(root, 'libs/pi-extensions/pi-ext')")
  })

  it('rejects missing required target fixtures and Nx alias recursion', () => {
    for (const [name, targets] of Object.entries(commands)) {
      const config = readJson(join(projects[name as keyof typeof projects], 'project.json'))
      for (const target of Object.keys(targets)) {
        const removed = { ...config.targets }
        delete removed[target]
        expect(() => assertTargets(name as keyof typeof commands, removed)).toThrow()
      }
    }
    const pkg = readJson('package.json')
    expect(pkg.nx).toBeUndefined()
    expect(readJson('apps/desktop/package.json').nx.includedScripts).toEqual([])
    for (const target of Object.values(commands).flatMap((targets) => Object.values(targets))) {
      expect(target).not.toMatch(/npm run nx:|\bnx (run|run-many|affected)\b/)
    }
    expect(pkg.scripts.postinstall).toBe('npm ci --prefix apps/desktop')
  })

  it('site deploy inputs are exactly the deploy workflow path filter', () => {
    const workflow = readFileSync(join(root, '.github/workflows/deploy-site.yml'), 'utf8')
    const block = workflow.match(/ {4}paths:\n((?: {6}- .*\n)+)/)?.[1] ?? ''
    const paths = [...block.matchAll(/- '([^']+)'/g)].map((match) => match[1])
    const declared = readJson('apps/site/project.json').namedInputs.deploy.map((input: string) =>
      input.replace('{workspaceRoot}/', '').replace(/\/\*\*\/\*$/, '/**'),
    )
    expect(paths.sort()).toEqual(['apps/site/**', ...declared].sort())
  })

  it('desktop release inputs cover every repository file the release and install consume', () => {
    const declared = readJson('apps/desktop/project.json').namedInputs.release.map(
      (input: string) => input.replace('{workspaceRoot}/', ''),
    )
    const release = readFileSync(join(root, '.github/workflows/release-continuous.yml'), 'utf8')
    // Executed paths, not names mentioned in comments.
    const code = release
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    const used = [...code.matchAll(/tools\/scripts\/[\w.-]+/g)].map((match) => match[0])
    const scope = readFileSync(join(root, 'tools/scripts/release-scope.mjs'), 'utf8')
    for (const [, file] of scope.matchAll(/from '\.\/([\w.-]+)'/g))
      used.push(`tools/scripts/${file}`)
    const install = readJson('apps/desktop/package.json').scripts.postinstall
    used.push(...[...install.matchAll(/\.\.\/\.\.\/(tools\/scripts\/[\w.-]+)/g)].map((m) => m[1]))
    for (const file of new Set(used)) expect(declared).toContain(file)
    expect(declared).toContain('.github/workflows/release-continuous.yml')
  })

  it('uses workspaceRoot inputs to include nested projects in the unchanged full unit runner', () => {
    const config = readJson('nx.json')
    expect(config.namedInputs.workspace).toContain('{workspaceRoot}/**/*')
    expect(config.neverConnectToCloud).toBe(true)
    expect(config.plugins).toEqual([])
    expect(config.parallel).toBe(3)
    expect(config.cacheDirectory).toBe('.nx/cache')
    expect(config.useDaemonProcess).toBe(false)
    expect(
      Object.values(config.targetDefaults).every(
        (target: unknown) => (target as { cache: boolean }).cache === false,
      ),
    ).toBe(true)
    expect(config.targetDefaults['nx:run-commands'].cache).toBe(false)
    expect(graph.nodes.desktop.data.targets.build.outputs).toEqual(['{projectRoot}/out'])
    expect(graph.nodes.host.data.targets.build.outputs).toEqual(['{projectRoot}/dist'])
    expect(graph.nodes.site.data.targets.build.outputs).toEqual([
      '{projectRoot}/dist',
      '{projectRoot}/public/og.png',
    ])
    const vitest = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    for (const path of [
      'apps/desktop/electron',
      'apps/host/src',
      'libs/session-runtime/src',
      'libs/shared/src',
      'libs/pi-extensions/pi-ext',
      'apps/desktop/src',
      'tools/scripts',
    ]) {
      expect(vitest).toContain(`'${path}/**/*.test.ts'`)
    }
    expect(vitest).toContain("'apps/desktop/src/**/*.test.tsx'")
    expect(readJson('tools/scripts/project.json').targets.test.options.command).toBe(
      readJson('package.json').scripts.test,
    )
  })
})
