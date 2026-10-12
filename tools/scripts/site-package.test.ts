import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const json = (path: string) => JSON.parse(read(path))

describe('independent apps/site package contract', () => {
  it('keeps root aliases explicit and installation separate from Desktop', () => {
    const scripts = json('package.json').scripts
    expect(scripts.postinstall).toBe('npm ci --prefix apps/desktop && npm ci --prefix apps/control')
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

  it('uses the self-contained site context for CI and deployment without changing runtime policy', () => {
    const ci = read('.github/workflows/ci.yml')
    const deploy = read('.github/workflows/deploy-site.yml')
    expect(ci).toContain('cache-dependency-path: apps/site/package-lock.json')
    expect(ci).toContain('working-directory: apps/site')
    expect(ci).toContain('docker build -t phosphor-site-ci ./apps/site')
    expect(ci).toContain('path: apps/site/test-results/')
    for (const command of ['npm ci', 'npm run check', 'npm run build', 'npm test']) {
      expect(ci).toContain(`${command} --prefix apps/site`)
    }
    expect(deploy).toContain("- 'apps/site/**'")
    expect(deploy).toContain('context: ./apps/site')
    expect(deploy).toContain('test -f apps/site/src/assets/shots/ide-flex.png')
    expect(deploy).not.toContain("- 'site/**'")
    const docker = read('apps/site/Dockerfile')
    expect(docker).toContain('RUN npm ci')
    expect(docker).toContain('RUN npm run check && npm run build')
    expect(docker).toContain('RUN apk add --no-cache font-dejavu')
    expect(docker).toContain('COPY --from=builder /app/dist /usr/share/nginx/html')
    expect(docker).toContain('USER 101:101')
    expect(docker).toContain('EXPOSE 5015')
    expect(ci).toContain('--read-only --cap-drop ALL')
    expect(ci).toContain('--security-opt no-new-privileges')
    expect(read('apps/site/.dockerignore').split('\n')).toEqual(
      expect.arrayContaining([
        'node_modules',
        'dist',
        '.astro',
        'test-results',
        'playwright-report',
      ]),
    )
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
    expect(read('apps/site/README.md')).toContain('docker build -t phosphor-site-local ./apps/site')
  })
})
