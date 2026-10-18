import { build } from 'esbuild'
import { chromium, webkit } from 'playwright'
import { expect, it } from 'vitest'

it.each([
  ['Chromium', chromium],
  ['WebKit', webkit],
] as const)(
  'verifies real Ed25519 proofs offline in %s',
  async (_name, engine) => {
    const bundle = await build({
      stdin: {
        contents: `
      export { browserCrypto } from '@phosphor/host-client/crypto';
      export { helloProofMessage } from '@phosphor/shared/host-protocol';
      export { encodeBase64url } from '@phosphor/shared/host-grant';`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'subject',
      write: false,
    })
    const browser = await engine.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
      )
      await page.goto('https://fixture.invalid')
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      const result = await page.evaluate(async () => {
        const s = (
          globalThis as unknown as {
            subject: {
              browserCrypto: {
                verify(key: string, message: Uint8Array, proof: string): Promise<boolean>
              }
              helloProofMessage(host: string, epoch: string, challenge: string): string
              encodeBase64url(bytes: Uint8Array): string
            }
          }
        ).subject
        const pair = (await crypto.subtle.generateKey('Ed25519', true, [
          'sign',
          'verify',
        ])) as CryptoKeyPair
        const wrong = (await crypto.subtle.generateKey('Ed25519', true, [
          'sign',
          'verify',
        ])) as CryptoKeyPair
        const key = (await crypto.subtle.exportKey('jwk', pair.publicKey)).x!
        const wrongKey = (await crypto.subtle.exportKey('jwk', wrong.publicKey)).x!
        const message = (host = 'host', epoch = 'epoch', challenge = 'challenge') =>
          new TextEncoder().encode(s.helloProofMessage(host, epoch, challenge))
        const signature = s.encodeBase64url(
          new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, message())),
        )
        return Promise.all([
          s.browserCrypto.verify(key, message(), signature),
          s.browserCrypto.verify(wrongKey, message(), signature),
          s.browserCrypto.verify(key, message('impostor'), signature),
          s.browserCrypto.verify(key, message('host', 'old'), signature),
          s.browserCrypto.verify(key, message('host', 'epoch', 'old'), signature),
          s.browserCrypto.verify(key, message(), 'malformed'),
        ])
      })
      expect(result).toEqual([true, false, false, false, false, false])
    } finally {
      await browser.close()
    }
  },
  30000,
)

it.each([
  ['Chromium', chromium],
  ['WebKit', webkit],
] as const)(
  'uses the portable socket with browser WebSocket in %s',
  async (_name, engine) => {
    const bundle = await build({
      entryPoints: ['@phosphor/host-client/socket'],
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: 'subject',
      write: false,
    })
    const browser = await engine.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.route('**/*', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
      )
      await page.routeWebSocket('wss://fixture.invalid/stream', (socket) => {
        socket.onMessage(() => socket.send('fixture-reply'))
      })
      await page.goto('https://fixture.invalid')
      await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
      const reply = await page.evaluate(async () => {
        const s = (
          globalThis as unknown as {
            subject: {
              openHostSocket(url: string): Promise<{
                onMessage(cb: (text: string) => void): void
                send(text: string): void
                close(): void
              }>
            }
          }
        ).subject
        const socket = await s.openHostSocket('wss://fixture.invalid/stream')
        return new Promise<string>((resolve) => {
          socket.onMessage((text) => {
            socket.close()
            resolve(text)
          })
          socket.send('fixture-request')
        })
      })
      expect(reply).toBe('fixture-reply')
    } finally {
      await browser.close()
    }
  },
  30000,
)
