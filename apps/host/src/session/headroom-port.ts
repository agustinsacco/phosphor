import { execFile } from 'node:child_process'
import { readdir, readFile, readlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { promisify } from 'node:util'

/** Ask the kernel for a free loopback port. Ownership is proved separately, after spawn. */
export function freeHeadroomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const bound = probe.address()
      probe.close((error) => {
        if (error || !bound || typeof bound === 'string') reject(error ?? new Error('No port'))
        else resolve(bound.port)
      })
    })
  })
}

async function linuxListener(pid: number, port: number): Promise<boolean> {
  const inodes = new Set<string>()
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  // A dual-stack socket can present an IPv4-mapped loopback address in tcp6.
  for (const [table, address] of [
    ['tcp', '0100007F'],
    ['tcp6', '0000000000000000FFFF00000100007F'],
  ]) {
    const text = await readFile(`/proc/net/${table}`, 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      const fields = line.trim().split(/\s+/)
      if (fields[1] === `${address}:${hex}` && fields[3] === '0A')
        inodes.add(`socket:[${fields[9]}]`)
    }
  }
  if (!inodes.size) return false
  const folder = `/proc/${pid}/fd`
  for (const fd of await readdir(folder)) {
    if (inodes.has(await readlink(`${folder}/${fd}`).catch(() => ''))) return true
  }
  return false
}

/** Once per child, not per request. A healthy endpoint alone isn't evidence the child owns it. */
export async function ownsHeadroomPort(pid: number, port: number): Promise<boolean> {
  if (process.platform === 'linux') return linuxListener(pid, port)
  if (process.platform !== 'darwin') return false
  const { stdout } = await promisify(execFile)(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'],
    { timeout: 2000 },
  )
  const fields = stdout.split('\n')
  return fields.includes(`p${pid}`) && fields.includes(`n127.0.0.1:${port}`)
}
