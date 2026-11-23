import { expect, it } from 'vitest'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkedLayout } from './assert-scratch.mjs'
import { fence, fixtureEnv } from './fixture.mjs'

it.skipIf(process.platform !== 'darwin')(
  'fences even embedded absolute paths and allows the scratch socket',
  () => {
    const scratch = mkdtempSync(join(tmpdir(), 'r0-')),
      outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'r0-src-')))
    try {
      const layout = checkedLayout(scratch),
        { root, roots } = layout,
        synthetic = join(outside, 'synthetic')
      writeFileSync(synthetic, 'unchanged')
      mkdirSync(roots.home)
      mkdirSync(dirname(roots.socket), { recursive: true })
      const profile = fence(root, roots, { agent: outside, userData: outside })
      const script = `const fs=require('node:fs'),net=require('node:net');
      for(const attempt of [()=>fs.readFileSync(process.argv[1]),()=>fs.writeFileSync(process.argv[1],'modified')]){
        try{attempt();process.exit(2)}catch(e){if(e.code!=='EPERM' && e.code!=='EACCES')throw e}
      }
      const socket=process.env.PHOSPHOR_LOCAL_DAEMON_SOCKET, server=net.createServer(c=>c.end());
      server.listen(socket,()=>{ const c=net.connect(socket); c.on('end',()=>server.close()); c.resume() })`
      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        [...profile, process.execPath, '-e', script, synthetic],
        { cwd: roots.home, env: fixtureEnv(layout), stdio: 'ignore', timeout: 5000 },
      )
      expect(result.status).toBe(0)
      expect(readFileSync(synthetic, 'utf8')).toBe('unchanged')
    } finally {
      rmSync(scratch, { recursive: true })
      rmSync(outside, { recursive: true })
    }
  },
)
