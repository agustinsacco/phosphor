# Public-safe product captures

All images in `apps/site/src/assets/shots/` and `docs/img/` are current-renderer
**Product demo · fictional data** captures. These are not live sessions, measured
agent results, verified account limits, or screenshots of a user's machine.
`remote-hosts.webp` now depicts the fictional delegation scenario, **not** the old
recorded Remote Hosts lane. That historical story is separate prose.

## Reproduce

From an isolated checkout, with Node >= 22.23.4:

```sh
npm ci
npm ci --prefix apps/site
npm run dev:web -- --host 127.0.0.1 --port 5199
# Another terminal, in this same checkout:
node apps/site/scripts/refresh-shots.mjs
node --test apps/site/scripts/capture-assets.test.mjs
```

`GUIDE_HARNESS_URL` accepts another localhost port. Every browser profile is new,
with no persistence or imported cookies. Requests outside that exact renderer
origin are blocked. No Electron main process, actual Host, Control service,
provider, Slack, GitHub, credential store or database is used by the capture.
The browser calls only the existing fictional preload bridge and fixture overrides.
Do not substitute `capture-live-shots.mjs`.

Targeted entrypoints:

```sh
node apps/site/scripts/guide-shots.mjs          # settings views
node apps/site/scripts/mobile-shots.mjs         # phone and wide PWA shells
node apps/site/scripts/remote-hosts-shot.mjs     # fictional subagents, legacy hero filename
node apps/site/scripts/remote-hosts-shot.mjs --demo  # same scenario, subagents filename
```

After a targeted run regenerate the complete inventory:

```sh
node --input-type=module -e "import('./apps/site/scripts/capture-harness.mjs').then(m => m.finishInventory())"
```

`fixtures/capture-inventory.json` records every output's dimensions, bytes and
provenance. `ide-flex.png` intentionally remains PNG: imports and deployment check
that filename. Every site capture has a PNG counterpart in `docs/img/`. Close-ups
come from actual popup bounds; there are no fixed 2880×1840 crop assumptions.
The optional raw importer expects separately captured `models-picker.png` and
`context-meter.png`, not historical-coordinate crops.

## Fixture worlds

- `lane-demo.json`: invented token-refresh implementation/review. Its test-result
  prose is explicitly demo content, not a test executed by the screenshot runner.
  `auth-demo.json` supplies matching current/baseline TypeScript to the file API
  and Files/Changes panes; the terminal honestly
  shows the browser harness's echo-only shell. The artifact is Markdown rendered
  by the real artifact viewer, not a composited document.
- `brain-demo.json`: seven people and things and seven memories from the fictional Harbor
  handover and planning lanes. Tom took over billing from Rina. His Kestrel link ended in
  August. He and Northwind appear in a memory without a stated relationship.
- `brain-backend.mjs`: the v8 mock explorer walks these memories and answers Ask. The saved
  handover and Brain Agent’s later link are staged journal entries backed by the same notes.
  Setup and the queue use the mock lifecycle. No model is downloaded, no provider is called
  and the capture does not test persistence or Undo.
- `brain-graph` starts with Rina’s card. `brain-memory` follows the sentence to Tom.
  `brain-changes` shows the saved read and the reason for the link. `brain-extraction` opens
  its read record. `brain-recall` shows the Ask answer and its lit trail, not a chat reply.
- `subagents-demo.json`: fictional four-workstream delegation and parent guidance.
  The UI can show simulated activity; no workers are launched. The old
  `remote-hosts.json` is retained only as an unused historical editorial fixture.
- Machines, provider/account/settings data use the checked-in browser harness.
  Home uses zero simulated compression savings so the hero makes no savings claim.
  Account addresses end in `example.com`; PR identities are replaced in API data
  with `harbor-demo`. Slack uses one invented permalink and is **only a link list**,
  never a synchronized Slack inbox. Package versions/usage are illustrative.
- `mobile-entry.mjs` mounts the actual shipped `CompactApp` over the fictional
  Host bridge. The phone is a 430×932 viewport at scale 2; it is not a narrow
  Desktop screenshot. Wide PWA is 1600×1000 at scale 2. Neither proves connectivity,
  enrollment, service-worker installation or background execution.

## Publication checks

Inspect the full originals, not only site previews. All images are re-encoded by
Sharp without EXIF/XMP/ICC metadata. No post-capture redaction, DOM text replacement,
CSS privacy blur, composite UI or production source patch is used. Native modal
backdrops may blur the already-fictional underlying app as they do in the product;
no unredacted private originals exist.

The asset tests verify inventory coverage/dimensions/bytes/metadata, coherent Brain
references, and import behavior for smaller full-window/cropped images. Playwright
captures exercise the real renderer but do not validate live provider outcomes.
Graph layout and relative-time labels may vary slightly across runs; provenance
and fixture content are stable. Keep demo labels on every site/README use.
