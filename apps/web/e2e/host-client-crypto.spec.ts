import { expect, test, type Page } from '@playwright/test'
import { build } from 'esbuild'
import { encodeBase64url } from '@phosphor/shared/host-grant'
import { helloProofMessage } from '@phosphor/shared/host-protocol'

/** A real Ed25519 key pair, a second public key and a proof, signed in Node. */
async function signedFixture() {
  const { subtle } = globalThis.crypto
  const pair = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const wrong = (await subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair
  const message = new TextEncoder().encode(helloProofMessage('host', 'epoch', 'challenge'))
  return {
    key: (await subtle.exportKey('jwk', pair.publicKey)).x!,
    wrongKey: (await subtle.exportKey('jwk', wrong.publicKey)).x!,
    signature: encodeBase64url(
      new Uint8Array(await subtle.sign('Ed25519', pair.privateKey, message)),
    ),
  }
}

// Runs once per engine project (Chromium and WebKit): the Host client's own
// crypto and socket code, bundled for the browser, against a routed page.
async function blankPage(page: Page) {
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<html></html>' }),
  )
}

test('verifies real Ed25519 proofs offline', async ({ page }) => {
  const bundle = await build({
    stdin: {
      contents: `
      export { browserCrypto } from '@phosphor/host-client/crypto';
      export { helloProofMessage } from '@phosphor/shared/host-protocol';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'subject',
    write: false,
  })
  await blankPage(page)
  await page.goto('https://fixture.invalid')
  await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
  // Keys and the signature come from Node, so the browser runs only the
  // code under test: WebKit's own generateKey/sign intermittently threw
  // OperationError on CI before verify was ever reached.
  const fixture = await signedFixture()
  const result = await page.evaluate(async ({ key, wrongKey, signature }) => {
    const s = (
      globalThis as unknown as {
        subject: {
          browserCrypto: {
            verify(key: string, message: Uint8Array, proof: string): Promise<boolean>
          }
          helloProofMessage(host: string, epoch: string, challenge: string): string
        }
      }
    ).subject
    const message = (host = 'host', epoch = 'epoch', challenge = 'challenge') =>
      new TextEncoder().encode(s.helloProofMessage(host, epoch, challenge))
    return Promise.all([
      s.browserCrypto.verify(key, message(), signature),
      s.browserCrypto.verify(wrongKey, message(), signature),
      s.browserCrypto.verify(key, message('impostor'), signature),
      s.browserCrypto.verify(key, message('host', 'old'), signature),
      s.browserCrypto.verify(key, message('host', 'epoch', 'old'), signature),
      s.browserCrypto.verify(key, message(), 'malformed'),
    ])
  }, fixture)
  expect(result).toEqual([true, false, false, false, false, false])
})

test('uses the portable socket with browser WebSocket', async ({ page }) => {
  const bundle = await build({
    entryPoints: ['@phosphor/host-client/socket'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'subject',
    write: false,
  })
  await blankPage(page)
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
})
