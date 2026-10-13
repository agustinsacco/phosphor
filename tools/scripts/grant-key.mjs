#!/usr/bin/env node
import { randomBytes } from 'node:crypto'

// stdout only: pipe directly into the operator's secret store.
process.stdout.write(`${randomBytes(8).toString('hex')}=${randomBytes(32).toString('base64url')}\n`)
