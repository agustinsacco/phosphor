import type { Writable } from 'node:stream'

// ws's ESM entry (wrapper.mjs) exports its frame parser, but @types/ws 8.18.2
// declares no Receiver at all. remote-host.ts builds one to read the frames a
// client sends, so only the constructor option it passes is declared here;
// write/on/destroy come from Writable.
declare module 'ws' {
  export class Receiver extends Writable {
    constructor(options?: { isServer?: boolean })
  }
}
