import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const json = (path: string) => JSON.parse(read(path))

describe('independent apps/site package contract', () => {
  it('keeps root aliases explicit and installation separate from Desktop', () => {
    const scripts = json('package.json').scripts
    expect(scripts.postinstall).toBe(
      'npm ci --prefix apps/desktop && npm ci --prefix apps/control && npm ci --prefix apps/web',
    )
    expect(scripts['site:install']).toBe('npm ci --prefix apps/site')
    for (const command of ['dev', 'check', 'build']) {
      expect(scripts[`site:${command}`]).toBe(`npm run ${command} --prefix apps/site --`)
    }
    expect(scripts['site:test']).toBe('npm test --prefix apps/site --')
    const site = json('apps/site/package.json')
    const lock = json('apps/site/package-lock.json')
    expect(lock.packages[''].dependencies).toEqual(site.dependencies)
    expect(lock.packages[''].devDependencies).toEqual(site.devDependencies)
    expect(site.scripts.prebuild).toBe('node scripts/social.mjs')
    expect(site.scripts.build).toBe('astro build')
    expect(site.dependencies.sharp).toBeDefined()
    expect(JSON.stringify(lock)).not.toMatch(/node_modules\/(electron|node-pty)(?:\/|")/)
  })

  it('uses the combined repo-root image for CI and deployment with isolated installs', () => {
    const ci = read('.github/workflows/ci.yml')
    const deploy = read('.github/workflows/deploy-site.yml')
    const script = read('tools/scripts/site-image.sh')
    expect(ci).toContain('cache-dependency-path: apps/site/package-lock.json')
    expect(ci).toContain('working-directory: apps/site')
    expect(ci).toContain('bash tools/scripts/site-image.sh')
    expect(ci).toContain('path: apps/site/test-results/')
    expect(ci).toContain('npm ci --prefix apps/site')
    expect(script).toContain('npm test --prefix apps/site')
    expect(script).toContain('docker build -f apps/control/Dockerfile')
    for (const path of [
      'apps/site/**',
      'apps/control/**',
      'apps/web/**',
      'libs/client-ui/**',
      'libs/pi-extensions/**',
      'libs/host-client/**',
      'libs/shared/src/**',
      'tools/scripts/site-image.sh',
    ])
      expect(deploy).toContain(`- '${path}'`)
    expect(deploy).toContain('context: .\n          file: apps/control/Dockerfile')
    expect(deploy).toContain('test -f apps/site/src/assets/shots/ide-flex.png')
    expect(deploy).not.toContain("- 'site/**'")
    const docker = read('apps/control/Dockerfile')
    expect(docker).toContain('RUN npm ci\n')
    expect(docker).toContain('RUN npm ci --prefix apps/control')
    expect(docker).toContain('ARG PHOSPHOR_WEB_ENABLED=false')
    expect(docker).toContain('PUBLIC_PHOSPHOR_WEB_ENABLED="$PHOSPHOR_WEB_ENABLED" npm run build')
    expect(docker).not.toContain('ARG CONTROL_WEB_SESSION_KEYS')
    expect(docker).toContain('RUN apk add --no-cache font-dejavu')
    expect(docker).toContain('COPY --from=site /app/dist ./site')
    expect(docker).toContain('COPY --from=control /app/apps/control/dist/server.mjs ./server.mjs')
    expect(docker).toContain('COPY --from=web /app/apps/web/dist ./web')
    expect(docker).toContain('RUN npm ci --ignore-scripts')
    expect(docker).toContain('RUN npm ci --prefix apps/web --ignore-scripts')
    expect(deploy).toContain('PHOSPHOR_BUILD_SHA=${{ needs.guard.outputs.sha }}')
    expect(deploy).toContain('PHOSPHOR_WEB_ENABLED=${{ needs.guard.outputs.web_enabled }}')
    for (const helper of ['lane-reload', 'swarm', 'subagent-snapshot']) {
      expect(docker).toContain(`libs/pi-extensions/pi-ext/${helper}.ts`)
      expect(read('apps/control/Dockerfile.dockerignore')).toContain(
        `!libs/pi-extensions/pi-ext/${helper}.ts`,
      )
    }
    expect(docker).toContain('USER 1000:1000')
    expect(docker).toContain('EXPOSE 5015')
    expect(docker).toContain('ENV NODE_ENV=production')
    expect(script).toContain('--read-only --cap-drop ALL')
    expect(script).toContain('--security-opt no-new-privileges --user 1000:1000')
    expect(script).toContain('trap cleanup EXIT')
    expect(read('apps/control/Dockerfile.dockerignore').split('\n')).toEqual(
      expect.arrayContaining([
        '**/node_modules',
        '**/dist',
        '**/.astro',
        '**/test-results',
        '**/playwright-report',
        '**/.git',
        '**/.phosphor',
        'apps/desktop',
        'apps/host',
        '**/.env*',
        '**/*.pem',
      ]),
    )
    expect(json('apps/control/package.json').devDependencies.esbuild).toBe(
      json('package.json').devDependencies.esbuild,
    )
    expect(json('apps/control/package-lock.json').packages[''].devDependencies).toEqual(
      json('apps/control/package.json').devDependencies,
    )
  })

  it('renders only the three required Secret placeholders and preserves the rollout guards', () => {
    const deploy = read('.github/workflows/deploy-site.yml')
    expect(read('.infra/phosphor-site/secret.yaml')).toContain(
      "supabase-secret-key: '${SUPABASE_SECRET_KEY}'",
    )
    expect(read('.infra/phosphor-site/secret.yaml')).toContain(
      "edge-secret: '${CONTROL_EDGE_SECRET}'",
    )
    expect(read('.infra/phosphor-site/secret.yaml')).toContain(
      "grant-keys: '${CONTROL_GRANT_KEYS}'",
    )
    // Applied on its own with suppressed output, never through the kustomization.
    expect(read('.infra/phosphor-site/kustomization.yaml')).not.toContain('secret.yaml')
    const pod = read('.infra/phosphor-site/base/deployment.yaml')
    for (const key of ['supabase-secret-key', 'edge-secret', 'grant-keys'])
      expect(pod).toContain(`key: ${key}`)
    expect(pod).not.toMatch(/optional:\s*true/)
    // Both probes ask the process, not the site files.
    expect(pod.match(/path: \/healthz\n/g)).toHaveLength(2)
    expect(pod).not.toMatch(/path: \/\n/)
    expect(read('.infra/phosphor-site/base/service.yaml')).not.toContain('loadBalancerSourceRanges')
    expect(deploy).toContain(
      "envsubst '${SUPABASE_SECRET_KEY} ${CONTROL_EDGE_SECRET} ${CONTROL_GRANT_KEYS}'",
    )
    expect(deploy).toContain('^[A-Za-z0-9_-]{32,512}$')
    expect(deploy).toContain('umask 077')
    expect(deploy).toContain("grep -Fq '${'")
    expect(deploy).toContain(`trap 'rm -f "$secret" "$web_secret" "$manifest"' EXIT`)
    expect(deploy).toContain('if ! kubectl apply -f "$secret" >/dev/null 2>&1; then')
    expect(pod).toContain('phosphor.saccolabs.com/deploy-run: local')
    expect(deploy).toContain('image: ${IMAGE_NAME}@${IMAGE_DIGEST}')
    expect(deploy).toContain(
      'if: always()\n        run: rm -f "$RUNNER_TEMP/phosphor-control-secret.yaml" "$RUNNER_TEMP/phosphor-web-secret.yaml" "$RUNNER_TEMP/phosphor-site.yaml"',
    )
    expect(deploy).toContain('timeout 120s')
    expect(deploy).toContain('.configured == true')
  })

  it('keeps browser activation coupled to one validated default-off flag', () => {
    const deploy = read('.github/workflows/deploy-site.yml')
    const base = read('.infra/phosphor-site/base/deployment.yaml')
    const web = read('.infra/phosphor-site/web/deployment.yaml')
    for (const name of ['CONTROL_WEB_ORIGIN', 'WEB_DIR', 'CONTROL_WEB_SESSION_KEYS']) {
      expect(base).not.toContain(name)
      expect(web).toContain(`name: ${name}`)
    }
    expect(web).toContain('value: https://phosphor-app.saccolabs.com')
    expect(web).toContain('value: /app/web')
    expect(web).toContain('name: phosphor-web')
    expect(web).not.toContain('optional:')
    expect(read('.infra/phosphor-site/web/kustomization.yaml')).not.toContain('secret.yaml')
    expect(read('.infra/phosphor-site/web/secret.yaml')).toContain(
      "session-keys: '${CONTROL_WEB_SESSION_KEYS}'",
    )
    expect(deploy).toContain('PHOSPHOR_WEB_ENABLED: ${{ vars.PHOSPHOR_WEB_ENABLED }}')
    expect(deploy).toContain('PHOSPHOR_WEB_ENABLED: ${{ needs.guard.outputs.web_enabled }}')
    expect(deploy.indexOf('Validate browser keys before publishing')).toBeLessThan(
      deploy.indexOf('- name: Build and push'),
    )
    expect(deploy).toContain('if ! kubectl apply -f "$web_secret" >/dev/null 2>&1; then')
    expect(deploy).not.toContain('kubectl delete')
    expect(deploy).toContain("if: needs.guard.outputs.web_enabled == 'true'")
    const page = read('apps/site/src/layouts/Page.astro')
    expect(page).toContain("import.meta.env.PUBLIC_PHOSPHOR_WEB_ENABLED === 'true'")
    expect(page).toContain('https://phosphor-app.saccolabs.com/')
    expect(page).toContain('Open the app')
    expect(page).not.toContain('/api/auth/start')
  })

  it('keeps icon generation and runnable documentation anchored to the relocated site', () => {
    expect(read('tools/scripts/generate-icons.mjs')).toContain(
      "join(root, 'apps/site', 'public', 'favicon.svg')",
    )
    const icon = read('apps/desktop/build/icon.svg')
    expect(icon).toContain('Regenerate platform assets with: node tools/scripts/generate-icons.mjs')
    expect(icon).not.toContain('node scripts/generate-icons.mjs')
    expect(read('apps/site/public/favicon.svg')).toBe(icon)
    for (const path of ['README.md', 'apps/site/README.md', 'docs/style-guide.md']) {
      const source = read(path)
      expect(source).not.toMatch(/--prefix site\b|\bcd site\b|`site\/(?:public|src|\*\*)/)
    }
    expect(read('apps/site/README.md')).toContain('bash tools/scripts/site-image.sh')
  })
})

// Execute the real workflow shell without contacting a cluster or using stored secrets.
it('validates deployment secrets before I/O, renders privately and cleans up on failure', () => {
  const source = read('.github/workflows/deploy-site.yml')
  const start = source.indexOf('        run: |', source.indexOf('- name: Apply and verify'))
  const end = source.indexOf('      - name: Remove rendered Secret manifest', start)
  const shell = source
    .slice(start + '        run: |\n'.length, end)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
  const work = mkdtempSync(join(tmpdir(), 'phosphor-deploy-test-'))
  const binary = (name: string, code: string) => {
    writeFileSync(join(work, name), `#!${process.execPath}\n${code}`)
    chmodSync(join(work, name), 0o755)
  }
  try {
    binary(
      'kubectl',
      `
      const fs = require('node:fs')
      const args = process.argv.slice(2)
      fs.appendFileSync(process.env.RUNNER_TEMP + '/calls', args[0] + '\\n')
      if (args[0] === 'get') process.exit(1)
      if (args[0] === 'kustomize') {
        fs.writeFileSync(process.env.RUNNER_TEMP + '/overlay', args[1])
        process.stdout.write(fs.readFileSync(process.env.RUNNER_TEMP + '/template'))
      }
      if (args[0] === 'apply' && args[2] !== '-') {
        const manifest = fs.readFileSync(args[2], 'utf8')
        const secrets = [
          process.env.SUPABASE_SECRET_KEY,
          process.env.CONTROL_EDGE_SECRET,
          process.env.CONTROL_GRANT_KEYS,
        ]
        if (args[2].endsWith('/phosphor-control-secret.yaml')) {
          if (!secrets.every((value) => manifest.includes(value))) process.exit(1)
          fs.writeFileSync(process.env.RUNNER_TEMP + '/mode', String(fs.statSync(args[2]).mode & 0o777))
          if (process.env.APPLY_FAIL) {
            // What a real failure may print: the object, raw and base64.
            const encoded = secrets.map((value) => Buffer.from(value).toString('base64')).join(' ')
            process.stdout.write(manifest + encoded)
            process.stderr.write(manifest + encoded)
            process.exit(1)
          }
        } else if (args[2].endsWith('/phosphor-web-secret.yaml')) {
          const value = process.env.CONTROL_WEB_SESSION_KEYS
          if (!manifest.includes(value) || (fs.statSync(args[2]).mode & 0o777) !== 0o600) process.exit(1)
          fs.writeFileSync(process.env.RUNNER_TEMP + '/web-applied', 'yes')
          if (process.env.WEB_APPLY_FAIL) {
            process.stderr.write(manifest + Buffer.from(value).toString('base64'))
            process.exit(1)
          }
        } else {
          if (fs.existsSync(process.env.RUNNER_TEMP + '/phosphor-web-secret.yaml')) process.exit(1)
          if (secrets.some((value) => manifest.includes(value))) process.exit(1)
          // The rendered Secret is gone before anything else is applied.
          if (fs.existsSync(process.env.RUNNER_TEMP + '/phosphor-control-secret.yaml')) process.exit(1)
          fs.writeFileSync(process.env.RUNNER_TEMP + '/applied', manifest)
        }
      }
      if (args[0] === 'apply' && args[2] === '-') process.stdin.resume()
    `,
    )
    binary(
      'envsubst',
      `
      if (![
        '$' + '{SUPABASE_SECRET_KEY} $' + '{CONTROL_EDGE_SECRET} $' + '{CONTROL_GRANT_KEYS}',
        '$' + '{CONTROL_WEB_SESSION_KEYS}',
      ].includes(process.argv[2])) process.exit(1)
      if (process.argv.length !== 3) process.exit(1)
      let input = ''
      process.stdin.on('data', chunk => input += chunk)
      process.stdin.on('end', () => {
        for (const name of ['SUPABASE_SECRET_KEY', 'CONTROL_EDGE_SECRET', 'CONTROL_GRANT_KEYS', 'CONTROL_WEB_SESSION_KEYS'])
          input = input.split('$' + '{' + name + '}').join(process.env[name])
        process.stdout.write(input + (process.env.LEAVE_PLACEHOLDER ? '$' + '{LEFT}' : ''))
      })
    `,
    )
    binary(
      'sed',
      `
      const fs = require('node:fs')
      const args = process.argv.slice(2)
      const path = args[args.length - 1]
      let input = fs.readFileSync(path, 'utf8')
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] !== '-e') continue
        const [, from, to] = args[i + 1].split('#')
        input = input.replace(from, to)
      }
      fs.writeFileSync(path, input)
    `,
    )
    const template = 'image: test:latest\n        phosphor.saccolabs.com/deploy-run: local\n'
    const secret = (length: number) => randomBytes(length).toString('base64url').slice(0, length)
    const grantKeys = (count = 1) =>
      Array.from(
        { length: count },
        (_, i) => `k${i}=${randomBytes(32).toString('base64url')}`,
      ).join(',')
    const run = (
      supabase: string,
      edge: string,
      suffix = '',
      applyFail = '',
      leave = '',
      grants = grantKeys(),
      webFlag = 'false',
      webKeys = '',
      webApplyFail = '',
    ) => {
      for (const name of ['calls', 'mode', 'applied', 'overlay', 'web-applied'])
        rmSync(join(work, name), { force: true })
      writeFileSync(join(work, 'template'), template + suffix)
      const result = spawnSync('bash', ['-c', shell], {
        encoding: 'utf8',
        cwd: root,
        env: {
          PATH: `${work}:${process.env.PATH}`,
          LC_ALL: 'en_US.UTF-8',
          RUNNER_TEMP: work,
          SUPABASE_SECRET_KEY: supabase,
          CONTROL_EDGE_SECRET: edge,
          CONTROL_GRANT_KEYS: grants,
          PHOSPHOR_WEB_ENABLED: webFlag,
          CONTROL_WEB_SESSION_KEYS: webKeys,
          WEB_APPLY_FAIL: webApplyFail,
          IMAGE_NAME: 'test',
          IMAGE_DIGEST: 'sha256:' + 'a'.repeat(64),
          GITHUB_RUN_ID: '4242',
          GITHUB_RUN_ATTEMPT: '2',
          APPLY_FAIL: applyFail,
          LEAVE_PLACEHOLDER: leave,
        },
      })
      const output = result.stdout + result.stderr
      for (const value of [supabase, edge, grants, webKeys].filter(Boolean)) {
        expect(output.includes(value)).toBe(false)
        expect(output.includes(Buffer.from(value).toString('base64'))).toBe(false)
      }
      expect(existsSync(join(work, 'phosphor-web-secret.yaml'))).toBe(false)
      expect(existsSync(join(work, 'phosphor-site.yaml'))).toBe(false)
      expect(existsSync(join(work, 'phosphor-control-secret.yaml'))).toBe(false)
      return result.status
    }
    for (const length of [32, 512]) {
      writeFileSync(join(work, 'phosphor-site.yaml'), '', { mode: 0o644 })
      expect(run(secret(length), secret(length))).toBe(0)
      expect(readFileSync(join(work, 'mode'), 'utf8')).toBe(String(0o600))
      const applied = readFileSync(join(work, 'applied'), 'utf8')
      expect(applied).toContain('image: test@sha256:' + 'a'.repeat(64))
      expect(applied).toContain("phosphor.saccolabs.com/deploy-run: '4242-2'")
    }
    for (const invalid of [
      secret(31),
      secret(513),
      secret(32) + '+',
      secret(32) + 'é',
      secret(32) + ' ',
      secret(32) + '\n',
    ]) {
      expect(run(invalid, secret(32))).toBe(1)
      expect(existsSync(join(work, 'calls'))).toBe(false)
      expect(run(secret(32), invalid)).toBe(1)
      expect(existsSync(join(work, 'calls'))).toBe(false)
    }
    // Disabled never applies browser credentials, even if a secret exists.
    expect(run(secret(32), secret(32), '', '', '', grantKeys(), 'false', grantKeys())).toBe(0)
    expect(readFileSync(join(work, 'overlay'), 'utf8')).toBe('.infra/phosphor-site')
    expect(existsSync(join(work, 'web-applied'))).toBe(false)
    expect(run(secret(32), secret(32), '', '', '', grantKeys(), 'true', grantKeys(8))).toBe(0)
    expect(readFileSync(join(work, 'overlay'), 'utf8')).toBe('.infra/phosphor-site/web')
    expect(existsSync(join(work, 'web-applied'))).toBe(true)
    for (const [flag, keys] of [
      ['true', ''],
      ['true', 'bad-key'],
      ['TRUE', grantKeys()],
    ]) {
      expect(run(secret(32), secret(32), '', '', '', grantKeys(), flag, keys)).toBe(1)
      expect(existsSync(join(work, 'calls'))).toBe(false)
    }
    expect(run(secret(32), secret(32), '', '', '', grantKeys(), 'true', grantKeys(), '1')).toBe(1)
    expect(existsSync(join(work, 'applied'))).toBe(false)
    // Grant keys: shape-checked here, strictly parsed by the server at startup.
    expect(run(secret(32), secret(32), '', '', '', grantKeys(8))).toBe(0)
    for (const invalid of [
      grantKeys(1) + '+',
      grantKeys(1) + ' ',
      grantKeys(1) + '\n',
      grantKeys(1) + 'é',
      'k=' + 'a'.repeat(4095),
    ]) {
      expect(run(secret(32), secret(32), '', '', '', invalid)).toBe(1)
      expect(existsSync(join(work, 'calls'))).toBe(false)
    }
    expect(run(secret(32), secret(32), '', '', '', 'k=' + 'a'.repeat(4094))).toBe(0)
    expect(run(secret(32), secret(32), '', '', '1')).toBe(1)
    expect(existsSync(join(work, 'mode'))).toBe(false)
    expect(run(secret(32), secret(32), '${UNRENDERED}')).toBe(1)
    expect(existsSync(join(work, 'applied'))).toBe(false)
    // A failing Secret apply prints its data; none of it may reach the log.
    const failing = run(secret(32), secret(32), '', '1')
    expect(failing).toBe(1)
    expect(readFileSync(join(work, 'mode'), 'utf8')).toBe(String(0o600))
    expect(existsSync(join(work, 'applied'))).toBe(false)
    // Empty secrets are refused too; avoid the output containment check for an empty string.
    const validation = shell.slice(0, shell.indexOf('umask 077'))
    for (const missing of ['SUPABASE_SECRET_KEY', 'CONTROL_EDGE_SECRET', 'CONTROL_GRANT_KEYS']) {
      const result = spawnSync('bash', ['-c', validation], {
        encoding: 'utf8',
        env: {
          LC_ALL: 'en_US.UTF-8',
          SUPABASE_SECRET_KEY: secret(32),
          CONTROL_EDGE_SECRET: secret(32),
          CONTROL_GRANT_KEYS: grantKeys(),
          [missing]: '',
        },
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('Invalid or missing ' + missing)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}, 15_000)
