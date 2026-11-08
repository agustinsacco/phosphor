#!/usr/bin/env node
/**
 * Fail when any native binary in a packaged Linux app needs a newer glibc than
 * Phosphor supports.
 *
 * Native modules (node-pty above all) are compiled on the build machine by
 * `npmRebuild` / `install-app-deps`, so they link against THAT machine's glibc.
 * v0.1.608 was built on an `ubuntu-latest` runner with glibc 2.42; its
 * `pty.node` required GLIBC_2.42, failed to load on Ubuntu 22.04 (2.35), and the
 * app died before opening a window. Nothing in the repo had changed.
 *
 * Usage: check-glibc-floor.mjs <dir> [floor]   (floor defaults to GLIBC_FLOOR)
 * Reads versioned symbol requirements with `objdump -T`.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Oldest glibc Phosphor's Linux build supports: Ubuntu 22.04 / Debian 12. */
export const GLIBC_FLOOR = '2.35'

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** Highest GLIBC_x.y referenced in `objdump -T` output, or null. */
export function maxGlibc(objdumpOutput) {
  let max = null
  for (const match of objdumpOutput.matchAll(/GLIBC_(\d+(?:\.\d+)+)/g)) {
    if (!max || compareVersions(match[1], max) > 0) max = match[1]
  }
  return max
}

function isNativeBinary(name) {
  return name.endsWith('.node') || /\.so(\.\d+)*$/.test(name)
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && isNativeBinary(entry.name)) yield path
  }
}

/** Only ELF files: the tree also carries darwin/win32 prebuilds. */
function isElf(path) {
  try {
    return execFileSync('file', ['-b', path], { encoding: 'utf8' }).startsWith('ELF')
  } catch {
    return false
  }
}

export function checkTree(dir, floor = GLIBC_FLOOR, dump = objdump) {
  const offenders = []
  let checked = 0
  for (const path of walk(dir)) {
    if (!isElf(path)) continue
    checked++
    const needed = maxGlibc(dump(path))
    if (needed && compareVersions(needed, floor) > 0) offenders.push({ path, needed })
  }
  return { checked, offenders }
}

function objdump(path) {
  return execFileSync('objdump', ['-T', path], { encoding: 'utf8', maxBuffer: 64 << 20 })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, floor = GLIBC_FLOOR] = process.argv.slice(2)
  if (!dir || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error('usage: check-glibc-floor.mjs <dir> [floor]')
    process.exit(2)
  }
  const { checked, offenders } = checkTree(dir, floor)
  if (checked === 0) {
    console.error(`::error::no ELF native binaries found under ${dir}`)
    process.exit(1)
  }
  for (const { path, needed } of offenders) {
    console.error(`::error::${path} needs GLIBC_${needed}, above the GLIBC_${floor} floor`)
  }
  if (offenders.length) process.exit(1)
  console.log(`glibc floor ${floor}: ${checked} native binaries OK`)
}
