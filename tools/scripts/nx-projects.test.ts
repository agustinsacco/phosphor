import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const readJson = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const projects = {
  'client-ui': 'libs/client-ui',
  web: 'apps/web',
  desktop: 'apps/desktop',
  host: 'apps/host',
  control: 'apps/control',
  runtime: 'libs/session-runtime',
  'host-client': 'libs/host-client',
  shared: 'libs/shared',
  'pi-extensions': 'libs/pi-extensions',
  site: 'apps/site',
  schema: 'supabase',
  tooling: 'tools/scripts',
}
const commands = {
  'client-ui': {
    typecheck: 'tsc --noEmit -p libs/client-ui/tsconfig.json',
    test: 'vitest run libs/client-ui',
  },
  web: {
    typecheck:
      'tsc --noEmit -p apps/web/tsconfig.json && tsc --noEmit -p apps/web/tsconfig.worker.json && tsc --noEmit -p apps/web/e2e/tsconfig.json',
    test: 'vitest run apps/web',
    build: 'npm run web:build',
    'test:e2e': 'npm run test:e2e:web',
  },
  desktop: { build: 'npm run build', 'test:e2e': 'npm run test:e2e' },
  host: {
    typecheck: 'tsc --noEmit -p apps/host/tsconfig.json',
    test: 'vitest run apps/host',
    build: 'node apps/host/scripts/build.mjs',
  },
  control: {
    typecheck: 'tsc --noEmit -p apps/control/tsconfig.json',
    test: 'vitest run apps/control',
    build: 'node apps/control/scripts/build.mjs',
  },
  runtime: { test: 'vitest run libs/session-runtime' },
  'host-client': {
    typecheck: 'tsc --noEmit -p libs/host-client/tsconfig.json',
    test: 'vitest run libs/host-client',
  },
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
    typecheck: 'node tools/scripts/typecheck.mjs',
    lint: 'eslint . && oxlint --type-aware .',
    test: 'vitest run',
    validate: './tools/scripts/validate.sh',
    'format-check': 'prettier --check .',
    'test:graph': 'vitest run tools/scripts/nx-projects.test.ts',
  },
}
// These edges include non-import resources and test-only consumers, not just
// production imports. No library depends on Desktop, and targets never recurse.
// Control's stack test consumes Desktop sign-in; Web consumes Control and Host.
// Nothing depends on `tooling` (the whole-workspace checks). The site declares
// consumed sources as deploy inputs instead of implicit project dependencies.
const dependencies = {
  'client-ui': ['shared', 'pi-extensions'],
  web: ['client-ui', 'host-client', 'shared', 'host', 'control'],
  desktop: ['runtime', 'shared', 'host-client', 'pi-extensions', 'client-ui'],
  host: ['runtime', 'shared', 'pi-extensions'],
  control: ['shared', 'desktop'],
  runtime: ['shared', 'host-client', 'pi-extensions'],
  'host-client': ['shared'],
  shared: [],
  'pi-extensions': ['shared'],
  site: [],
  schema: [],
  tooling: [
    'desktop',
    'host',
    'control',
    'runtime',
    'host-client',
    'shared',
    'pi-extensions',
    'site',
    'schema',
    'client-ui',
    'web',
  ],
}
// Workspace-wide checks read everything. Everything else reads its own root,
// its dependencies, and the specific root files it actually consumes.
const inputs: Record<string, Record<string, string[]>> = {
  'client-ui': {
    typecheck: ['default', '^default', 'rootInstall'],
    test: ['default', '^default', 'rootUnitRunner'],
  },
  web: {
    typecheck: ['default', '^default', 'rootInstall'],
    test: ['default', '^default', 'rootUnitRunner'],
    build: ['default', '^default', 'rootInstall'],
    'test:e2e': ['default', '^default', 'rootInstall'],
  },
  desktop: {
    build: ['default', '^default', 'rootInstall', 'release'],
    'test:e2e': ['default', '^default', 'rootInstall', 'release', 'e2eHarness'],
  },
  host: {
    typecheck: ['default', '^default', 'rootInstall'],
    test: ['default', '^default', 'rootUnitRunner'],
    build: ['default', '^default', 'rootInstall'],
  },
  control: {
    typecheck: ['default', '^default', 'rootInstall'],
    test: ['default', '^default', 'rootUnitRunner'],
    build: ['default', '^default', 'rootInstall'],
  },
  runtime: { '*': ['default', '^default', 'rootUnitRunner'] },
  'host-client': {
    typecheck: ['default', '^default', 'rootInstall'],
    test: ['default', '^default', 'rootUnitRunner'],
  },
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
  it('retains every current-path project and all import/resource/test edges', () => {
    expect(Object.keys(graph.nodes).sort()).toEqual(Object.keys(projects).sort())
    for (const [name, path] of Object.entries(projects)) {
      expect(graph.nodes[name].data.root).toBe(path)
      const edges = graph.dependencies[name].map((edge: { target: string }) => edge.target)
      assertEdges(name as keyof typeof dependencies, edges)
    }
  })

  it('keeps the Control sign-in test edge explicit without library-to-app edges or cycles', () => {
    expect(readJson('apps/control/project.json').implicitDependencies).toContain('desktop')
    expect(graph.dependencies.control).toContainEqual({
      source: 'control',
      target: 'desktop',
      type: 'implicit',
    })
    const active = new Set<string>()
    const visited = new Set<string>()
    const visit = (name: string) => {
      expect(active.has(name), `Cycle through ${name}`).toBe(false)
      if (visited.has(name)) return
      active.add(name)
      for (const { target } of graph.dependencies[name] as { target: string }[]) {
        if (graph.nodes[name].data.root.startsWith('libs/')) {
          expect(graph.nodes[target].data.root).not.toMatch(/^apps\//)
        }
        visit(target)
      }
      active.delete(name)
      visited.add(name)
    }
    for (const name of Object.keys(graph.nodes)) visit(name)
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
        const projectInputs = inputs[name as keyof typeof inputs]
        if (!projectInputs) throw new Error(`Missing inputs for ${name}`)
        expect(project.targets[target]).toMatchObject({
          executor: 'nx:run-commands',
          cache: false,
          inputs: projectInputs[target] ?? projectInputs['*'],
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
    expect(pkg.scripts.postinstall).toBe(
      'npm ci --prefix apps/desktop && npm ci --prefix apps/control && npm ci --prefix apps/web',
    )
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
    expect(graph.nodes.control.data.targets.build.outputs).toEqual(['{projectRoot}/dist'])
    expect(graph.nodes.site.data.targets.build.outputs).toEqual([
      '{projectRoot}/dist',
      '{projectRoot}/public/og.png',
    ])
    const vitest = readFileSync(join(root, 'vitest.config.ts'), 'utf8')
    for (const path of [
      'apps/desktop/electron',
      'apps/host/src',
      'apps/control/src',
      'libs/session-runtime/src',
      'libs/host-client/src',
      'libs/shared/src',
      'libs/pi-extensions/pi-ext',
      'libs/client-ui/src',
      'apps/web/src',
      'tools/scripts',
    ]) {
      expect(vitest).toContain(`'${path}/**/*.test.ts'`)
    }
    expect(vitest).toContain("'libs/client-ui/src/**/*.test.tsx'")
    expect(readJson('tools/scripts/project.json').targets.test.options.command).toBe(
      readJson('package.json').scripts.test,
    )
  })
})
