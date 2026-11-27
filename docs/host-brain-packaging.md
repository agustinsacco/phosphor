# Host Brain packaging

Host updates keep their four release targets and pinned Node. Ordinary releases
carry the Brain pi extensions and skill, but no embedding runtime or weights.
An ordinary release cannot advertise Host Brain on any target. Host Brain
handover requires a qualified bundle; an unsupported release does not take over
existing Desktop Brain data.

Only macOS arm64 is eligible for qualification. The candidate has isolated
search and embedding worker programs and pinned Node CPU dependencies. The
bundle keeps the existing archive policy: scoped npm packages use archive-safe
names, and Sharp and libvips keep their original native relative linkage. No
WASM binaries, other target natives, package install scripts, or model weights
ship. The current archive and updater limits remain in force (including the
256 MiB archive bound). Notices ship with the optional runtime; review third-party
redistribution obligations, including ONNX notices and the libvips source offer,
before distributing a qualified bundle.

## Qualify a candidate

On a macOS arm64 build runner with the locked build dependencies and a
pre-provisioned **offline**, terms-approved copy of the pinned EmbeddingGemma
files, run:

```sh
HOST_RELEASE_VERSION=1.2.3 node tools/host-release/build-bundle.mjs \
  --target darwin-arm64 --out "$BUILD_OUTPUT" --cache "$NODE_ARCHIVES" \
  --native "$STAGED_PTY" --brain-model "$OFFLINE_MODEL_DIRECTORY"
```

The model directory is the manifest's final model folder itself, not its parent.
The builder verifies sizes and SHA-256 before loading, tests the real packaged
workers with the pinned Node, and validates and extracts the result using both
the POSIX installer (temporary home and fixture signature only) and the updater's
extractor. It runs the real worker/model test again after extraction, checking
vector shape, norm, and ranking on a small synthetic corpus. Model files stay
outside the artifact. Missing/corrupt weights or a failed native smoke produce
no enabled artifact. The qualification marker is not a model-installed status;
product model setup is explicit and separately verified.

Normal CI exercises the same packaged native CPU binding with a generated
single-op synthetic ONNX graph and smoke-tests both worker protocols on macOS
arm64. That is not model qualification and does not create the qualification
marker. The ordinary release workflow checks installer/update archive extraction
and CLI launch on each release target before signing the verified artifacts.

`lib/brain-workers/brain-search-worker.js` and
`lib/brain-workers/brain-embedding-worker.js` share an ESM package boundary.
`resolvePackagedBrainRuntime(resourceRoot)` returns those paths only when the
installed resources, including the interactive Brain Agent guard, platform,
pinned Node version and model revision match the qualification marker. It does not load inference, look up user model files, or
make any network requests.

## Updates, rollback and repair

Before opening or creating a standalone Host Brain, the running Host checks that
its own bundle is still selected and qualified, under the same lock used by the
installers. Desktop handover pins the install before taking ownership. Both paths
leave the private, pathless `.brain-required` marker in `~/.local/lib/phosphor-host`.
A fresh standalone Host does not pin anything just by starting. The protection
follows the install even when `XDG_STATE_HOME` changes. For older installs without
a pin, replacement also checks the caller's and default Host state directories for
Brain state; it does not search other roots.

When Brain compatibility is required, the Host checks the candidate under the
lock before staging or selecting it, including automatic update, applying an
earlier stage and offline rollback. On failed health it restores the old bundle
only if it is compatible. Desktop's pre-setup installer does not replace a
protected install.

`phosphor uninstall` and `phosphor uninstall --purge --yes` refuse a protected
install before changing the service, launcher, config or state. A local
qualification marker on its own does not prove access to a signed qualified
repair release. The refusal leaves the program and pin in place.

If the selection or launcher is already missing, the current POSIX installer can
repair it **if** a signed qualified release is available. It checks the signed
manifest and artifact hash before extraction, then uses the verified candidate's
Node to check qualification under the lock. To reuse an existing version, the
installed tree must match the verified extraction byte for byte, with no links
and no missing or extra entries. Its modes must be, throughout, either the
installer's own extraction or the fixed modes `phosphor update` writes (0700 version
folder, 0755 folders, the release's 0644/0755 file modes), so the same signed
release repairs a tree either one installed. A mix of the two, or any other mode,
is refused. A conflicting existing version,
foreign launcher or unsafe selection is refused, not overwritten. Repair leaves
the pin and Host state in place. Ordinary bundles and older installers cannot
safely repair a protected install.
