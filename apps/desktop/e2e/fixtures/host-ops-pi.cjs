'use strict'

// Select the ops-capable RPC stub in disposable Host processes only.
if (process.argv.includes('--version')) process.stdout.write('1.2.0\n')
else {
  process.env.PHOSPHOR_E2E_OPS = '1'
  require('./pi-stub.cjs')
}
