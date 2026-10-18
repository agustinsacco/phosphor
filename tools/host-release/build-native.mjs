import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import process from 'node:process'
import { isEntryPoint, root, pin } from './common.mjs'
import { prepareNativeSource, stageNativeResources } from './native-stage.mjs'

export const PTY_VERSION = '1.1.0'
export function validateNative(folder, target) {
  const markerPath = join(folder, 'TARGET.json')
  const markerStat = lstatSync(markerPath)
  if (!markerStat.isFile() || markerStat.size > 1024) throw new Error('Invalid native marker')
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  if (marker.target !== target || marker.node !== pin.version || marker.version !== PTY_VERSION)
    throw new Error('Native target mismatch')
  const files = readdirSync(folder, { recursive: true })
  if (files.length > 100) throw new Error('Invalid native tree')
  let total = 0
  for (const file of files) {
    const stat = lstatSync(join(folder, file))
    total += stat.size
    if (
      (!stat.isFile() && !stat.isDirectory()) ||
      stat.size > 16 * 1024 * 1024 ||
      total > 64 * 1024 * 1024
    )
      throw new Error('Invalid native entry')
  }
  for (const file of ['lib/index.js', 'build/Release/pty.node', 'LICENSE']) {
    if (!lstatSync(join(folder, file)).isFile()) throw new Error('Missing native resource')
  }
  if (
    target.startsWith('darwin-') &&
    !lstatSync(join(folder, 'build/Release/spawn-helper')).isFile()
  )
    throw new Error('Missing spawn helper')
}
/** Build only on the target runner and verify using the exact bundled Node. */
export function buildNative(out, node) {
  const target = `${process.platform}-${process.arch}`
  if (!['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(target))
    throw new Error('Unsupported native target')
  const runtime = JSON.parse(
    execFileSync(
      node,
      [
        '-p',
        'JSON.stringify({version:process.versions.node,target:process.platform+"-"+process.arch})',
      ],
      { encoding: 'utf8' },
    ),
  )
  if (runtime.version !== pin.version || runtime.target !== target)
    throw new Error('Wrong native verification runtime')
  if (existsSync(out)) throw new Error('Native output already exists')
  const source = dirname(
    createRequire(import.meta.url).resolve('node-pty/package.json', {
      paths: [join(root, 'apps/desktop')],
    }),
  )
  if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version !== PTY_VERSION)
    throw new Error('Wrong node-pty version')
  const temp = mkdtempSync(join(tmpdir(), 'host-native-'))
  try {
    const nodeVersion = pin.version
    const { packageRoot, binary } = prepareNativeSource({ source, temp, target, nodeVersion })
    stageNativeResources({ packageRoot, binary, out, target, nodeVersion, ptyVersion: PTY_VERSION })
    validateNative(out, target)
    execFileSync(
      node,
      [
        '-e',
        `const p=require(${JSON.stringify(join(out, 'lib/index.js'))}); const t=p.spawn('/bin/sh',['-c','printf native-ok'],{cols:80,rows:24,cwd:'/tmp',env:{PATH:'/usr/bin:/bin'}}); let output='';t.onData(d=>output+=d); t.resize(81,25);t.onExit(e=>{if(e.exitCode!==0||!output.includes('native-ok'))process.exitCode=1});setTimeout(()=>process.exit(1),5000).unref()`,
      ],
      { stdio: 'pipe' },
    )
  } catch (error) {
    rmSync(out, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
if (isEntryPoint(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, node: { type: 'string' } } })
  if (!values.out || !values.node) throw new Error('Use --out DIR --node NODE')
  buildNative(resolve(values.out), resolve(values.node))
}
