# Brain

Brain is an opt-in, local Desktop prototype for evidence-backed memory across
lanes. It is not a shared agent, a session orchestrator, a sync service or a
source of instructions. Its claims need human review and can be wrong.

## Surface and consent

**Brain** sits below Machines. On Desktop, This Mac and All open **Brain · This
Mac**: All does not aggregate machines. An explicitly selected Host shows an
unavailable page without invoking the local service. The PWA also shows that
page, and its bridge refuses every `brain:*` channel. The Host exposes no Brain
API. `Platform.localBrain`, not screen width, chooses the capability.

Settings and lane actions separate four choices:

1. Enable Brain and enroll canonical local workspaces. Default is off.
2. Optionally enable recall into newly admitted interactive lanes.
3. Acknowledge the model's terms, then explicitly download local embeddings.
4. Explicitly choose a processing path: learn from a selected lane using its
   qualified source model/account, or select a model for the separate evidence
   processor. Each paid run needs its own consent.

Enablement never downloads a model or starts reasoning. Disablement and removing
an enrollment revoke access, but preserve stored data and installed model files.
Removing the model is not forgetting evidence. Retention defaults to 30 days,
accepts 1–3650 days, and decreasing it needs confirmation.

Workspaces include ordinary folders and Phosphor sandboxes, not only Git
repositories. Symlink spellings resolve to one scope. Git lanes still share
their canonical repository scope, including linked worktrees, and require a
known branch. A confirmed non-Git folder has no branch and recalls only
workspace-wide evidence. Broken Git metadata, detached checkouts and failed Git
queries are not treated as branchless folders. Inherited Git environment
variables cannot select a different repository for Brain authority.

Explore offers lexical/hybrid search, evidence-branch and time filters, an
accessible entity list, a bounded graph, citations and revision-checked
corrections. Blank branch means project-wide evidence only, not every branch.
The graph shows at most 32 nodes/64 edges and labels omissions. Animation pauses
when hidden, for reduced motion or manually. Adjacency is not causation.

Activity separates captured evidence from processing. Its inventory uses
50-row, metadata-only seek pages for an exact enabled/enrolled scope. A deleted
cursor does not break the next page. Read a source to inspect its original text;
forgetting requires a separate confirmation. Re-enroll a removed scope to inspect
its inventory. Removing enrollment alone is not an erasure request.

Status snapshots hold at most 200 rows per section with whole-row UTF-8 byte
budgets. Pending proposals and active jobs come first, newest first. Omission
sets `truncated`; review material is never silently clipped to fit. Handling
visible work exposes older rows. A graph-stale proposal can be rejected but not
approved. A policy-stale proposal cannot be approved or rejected under refreshed
consent; processing again creates eligible work under the new policy.

## Capture and recall

Automatic capture starts with a new baseline when an enrolled ordinary lane is
admitted or resumed. Automatic capture never imports existing history. Only new, plain user text from
successful `prompt`, `steer` or `follow_up` admission through the existing session
service is eligible. Slash commands, images, assistant/tool output, tagged or
generated input, unattended work and Brain processors are excluded.

The private `SessionMemoryAugmentation` hook records canonical scope and branch
immediately before dispatch. A later checkout cannot relabel that input.
Capture brackets `get_entries` with native identity reads and requires new entry
IDs, valid ancestry, admission time and an unambiguous exact match to a successful
receipt. First-observation cutoffs prevent an unresolved earlier receipt from
making pre-admission text eligible for a later one. Event scans defer settlement
until pending receipts complete; the bounded state retains IDs, not message bodies. Repeated/ambiguous text is omitted, not guessed. There is no filesystem
transaction spanning an external Git checkout and stdin delivery.

Session replacements, queue clearing, observed identity changes, exceeded
budgets or optional capture errors disable that lane's augmentation and revoke
its grant. New admission/resume establishes another baseline. Optional memory
failure must not reject an otherwise valid ordinary command or resume. Failures
are recorded through the existing main-process diagnostics. Capture snapshots
are bounded to 4,000 entries/1 MB, plain source text to 16,000 characters, and
pending admissions to 32; over-budget history is not partially imported.

With recall enabled, the optional working extension adds `brain_search` and
`brain_read`. Before each provider request it asks for a fresh brief about the
latest user message, limited to 2,400 characters and a 1.5-second deadline.
The brief is hidden, request-local, explicitly untrusted background data, not a
persistent system prompt or a session entry. Retrieval failure leaves the
request unchanged; it is not reported as “no memory.” Explicit tool failures
remain errors. Agents receive no maintenance or consolidation duties.

Delivered memory can appear in ordinary tool transcripts or provider requests.
Delivery records conservatively exclude recipient sessions from later evidence
capture, preventing recalled content from manufacturing independent support.
Forgetting cannot retract delivered copies. Root provenance and duplicate
content also prevent repeated/forked material from counting as independent
corroboration. Approval is not proof that a claim is true.

## Learn from a selected lane

A persisted local lane's shared menu offers **Learn from this lane** when its
workspace is enrolled and its source is ready. Plain folders and sandboxes do
not need Git. Private processors and memory-recipient sessions remain excluded,
including recipients of an empty recall result. Host/PWA lanes cannot start
local learning. There is no archive sweep, background queue, completion trigger,
automatic acceptance or unattended next batch.

Preflight reads the selected settled ancestry under the existing session-path
lock. It never forks, branches, edits or prompts the original runtime. A private
copy keeps original entries, the completed assistant answer, existing compaction
and context edits. Pi's own projection/converter decides what reaches the model;
omitted raw history is not represented as having been read. Unsupported, torn,
busy, conflicting or oversized sources refuse rather than being clipped or
compacted again. Images and other contexts without a qualified token bound
currently refuse before inference.

The consent dialog names the exact source session/leaf and digests, selected
provider/model/thinking, current credential slot, acknowledged workspace branch,
projected coverage and limitations. Current account/branch authority is not
proof of historical billing or branch identity. The account identity epoch is
also fenced privately: replacing a login in the same slot invalidates consent;
normal provider-owned token refresh does not authorize a different account.
Unknown source bindings, environment-only credentials, virtual routing and
unqualified custom providers refuse. There is no API-key-only downgrade or
provider/model/account fallback.

One separate private learner appends a final user instruction identifying itself
and treating the finished conversation as evidence, not instructions. It calls
the selected provider directly, outside the agent scheduler, with no executable
tools. Historical schemas stay inert. One logical generation, cancellation and
a whole-operation deadline are enforced; invalid JSON/citations, tool output,
truncation and errors stop without repair, continuation, warming or retries.
Provider-internal network attempts are not observable. Claude's qualified cold
path represents supplied plaintext thinking as labelled historical text, not
reconstructed hidden thinking or replayed opaque signatures.

Copied history does not guarantee an identical serialized provider prefix, a
warm CLI process or a cache hit. A new suffix does not make the retained context
free: a new run still sends the preserved projected context. Input/output/cache
read/cache-write usage is shown only when reported for that response. Unknown
values are unavailable, not zero; known reasoning is already included in
output. No dollar price, cumulative source-session usage or measured cache
benefit is inferred. Cancelled or interrupted requests may already be charged.

A queued/running job gives its source a blue link to a **private read-only
inspector**, not another ordinary lane/composer. Findings contain semantic
entities/relations and exact citations, become deterministically validated
proposals, and still need manual review. Explicit no-findings completes without
inventing a proposal. Only a durably stored valid result advances processed
coverage. Acceptance is separate: rejection does not erase coverage or
repurchase the conversation. Exact repeats reuse prior work; newly projected
content keeps older context but only new eligible contributions support findings.
Retry/reprocess is an explicit potentially paid acknowledgment, whose replay
reuses its successor rather than creating another job.

Checkpoints bind canonical scope, source identity/selected ancestry/content and
projection digests, frozen contribution identities and original dependencies.
Metadata-only appends and retained fork roots do not manufacture new work or
corroboration. Generated assistant/compaction text inherits original input
dependencies; those dependencies are not independent observations. Private
nontext anchors keep image/thinking-only dependencies involved in forgetting,
without inventing readable text. Outcomes expose retained chunk IDs so citations
remain readable after review or snapshot omission.

Learning uses the existing session service/registry/path locks and one active
job across both processing paths. Its private command requires a nonce/job-bound
acknowledgment and RPC `handled` disposition, never an ordinary prompt. Temporary
source/control files and events are excluded from ordinary list/read/edit/fork/
delete paths. Source copies are not accepted knowledge or a resumable agent.

**Qualification:** stock pi 1.4 alone is insufficient. Learning requires the
separately versioned bound-request capability. For live native sources, Desktop
brackets the optional read-only `get_auth_binding` RPC with source bytes, selected
ancestry, settled revision and registry checks. Its receipt must name the owned
source session and actual provider/model/API/endpoint, slot and identity fence;
missing, changed or unsupported receipts refuse without a disk-slot fallback.
OpenAI Responses, OpenAI Codex Responses and Anthropic Messages are qualified
native routes. Offline native sources have current configured-slot authority
only, never proven historical billing identity.

Desktop currently refuses both live and offline Claude learning: the required
actual account/process identity hook is not available. The separately repaired,
unshipped `pi-claude-cli 0.11.0` single-response path alone does not enable it.
These dependency changes are not installed or published by this feature branch.
No real-provider/cache benchmark is claimed.

Source freezing is bounded to 64 MiB/200,000 entries. The private carrier's
control/result files and combined process output are bounded to 2 MB; storage
input/receipts to 4 MB, 1,000 projected blocks/original dependencies and 200 newly
eligible text blocks. Findings are bounded to 32, with 2,000-character summaries/
quotes and eight citations each. Lossless retained text chunks are at most
16,000 characters with overlap for supported quotes. Capacity/context admission
refuses before paid work; these limits do not authorize silent truncation.

## Evidence processor and review

The separate evidence processor does not preserve an original lane's provider
context and is not the source-model learning path. Each explicit run selects at
most 200 whole sources and 60,000 UTF-8 source
bytes, prioritizing never-attempted evidence. It does not repeat applied or
still-valid pending work. Failed, cancelled, rejected and stale attempts can be
retried explicitly. Processing is not limited to the displayed inventory page,
and never loops automatically through all remaining batches. An individually
oversized source yields an identifiable error rather than a clipped proposal.

Processing requires pi ≥1.4.0 and an exact native `anthropic` or `openai` model
with the corresponding environment API key. Shared pi auth/config, CLI
providers, MCP tools and OAuth accounts are not supported for processing. These
restrictions do not change which providers ordinary lanes may use.

The processor uses the existing session service, registry and path-lock domain.
It has an isolated empty cwd/config, an allowlisted environment, no inherited
credentials except the selected native API key, one active job, a 120-second
whole-job deadline and a 16-tool-call bound. Only `brain_job` and `brain_propose`
are available; ordinary tools, resources, MCP and approval prompts are excluded.
Main verifies the exact model, owner and active tools before sending evidence
([private audit](extensions.md#brains-private-processor-audit)). Consent epoch
and job fences are checked again when serving input and accepting output.

A proposal does not mutate accepted claims. Human approval validates citations,
entity references, temporal fields and the reviewed revision. Corrections are
reasoned supersessions, not silent overwrites. Conflicting reports remain marked
contested. Revocation/cancellation stops the owned processor, including late
startup. Its events never enter ordinary renderer lane channels. Ordinary
resume/fork/edit/delete controls refuse its owned transcript.

## Storage, retention and forgetting

`libs/memory-engine` owns the SQLite/WAL/FTS5 graph and retained evidence through
an injected Node `DatabaseSync` port. `libs/brain-runtime` owns the Node-side
service, capture, source learning, manual processor, tool audit, indexing, private capability
transport and owned-transcript lifecycle. Its plain `BrainApi` methods have no
Electron or UI-channel dependency. Storage creation, embeddings and the existing
session service/registry/path locks are injected ports.

`apps/desktop/electron/brain` only binds Electron utility processes, application
paths, local provider resolution and shutdown. Desktop IPC maps the local-only
`brain:*` channels to the backend API. The shell reads bounded learning inventory
and policy metadata without creating an empty local store; explicitly opening
Brain or preparing an ordinary lane's optional memory can initialize it. Native Transformers loading remains in
the Desktop embedding worker; the portable embedding controller receives its
worker transport and model loader through ports. `libs/brain-client` contains
the bounded protocol/client used by the standalone pi extensions.

This separation does not enable Brain on the Host or in the PWA. A future Host
adapter must supply machine-owned storage/workers and authorized, scoped API
routing; the browser would use that Host, not run SQLite, native embeddings or
pi. No data is shared across machines. There is no new public listener, session
manager, scheduler or Python service. Learning adds private receipt/result,
coverage and dependency-anchor records to the existing store; default consent,
retrieval ranking and the fixed embedding model are unchanged. Downgrading a
learning-populated store to an older prototype reader is unsupported: that
reader cannot erase the new dependency/result records safely. Do not claim a
successful Forget from such an older reader covers learning data.

Storage is under Electron `userData/brain`: `memory.sqlite`, `evidence/`, owned
`sessions/`, temporary owned `learning/` roots, and `embeddings/`. Initialization
is lazy, after userData redirection;
opening Brain or preparing optional memory for an ordinary lane can initialize
its database even with capture off. No reasoning or model download follows.
Directories/files use private permissions. SQLite uses FULL synchronization and
secure deletion; source blobs are fsynced and atomically renamed before database
references commit. Startup removes orphan blobs. This is not encrypted storage.

Accepted cited claims, evidence and temporal revisions are authoritative.
Vectors, briefs, search indexes and layout are derived. Local indexing runs on
ready startup/enable and explicit data changes, with revision-fenced commits;
it never invokes a reasoning provider. Optional indexing failure is diagnosed
without turning an already-committed edit into a failed write.

Retention expires opportunistically on open, preference changes and reads, from
retention/ingestion time, not the source's reported timestamp. There is no timer.
Forget removes selected evidence and dependent memory, checkpoints/truncates
WAL, and durably queues owned processor transcripts for deletion. Purge stops
owned writers, takes the existing path lock and validates path, file identity
and ownership before unlinking. Display is capped at 2 MB, but deletion streams
arbitrarily long payloads in bounded memory. Malformed/foreign ownership or
nesting beyond 128 containers fails closed and leaves the purge queued for retry.

Learning forgetting/expiry also invalidates dependent coverage, private outcomes
and nontext anchors, including dependence on already-covered context. Failure to
stop or prove ownership of a private writer is not an erasure acknowledgment.
Recovery inventories temporary roots, including previews without job rows.
Ownership is persisted before copying input; possible-writer state precedes
spawn, and stopped state follows awaited writer disposal. Purge keeps ownership
metadata until copied payloads are removed. Cleanup errors are retryable; service
shutdown retains its cleanup ports rather than falsely acknowledging erasure.

Interrupted roots with uncertain live writers remain visible as pending cleanup
and block further admission. An arbitrary or reused PID does not authorize
killing or deletion. For the exact root named by the error, support-assisted
recovery requires:

1. Quit all Phosphor instances. Reboot if writer termination cannot otherwise be
   positively established; never kill a saved PID.
2. With the app stopped, verify that exact real directory under
   `userData/brain/learning`, its ownership and private-session markers. Do not
   edit metadata to manufacture a stopped proof.
3. Only after ownership and writer termination are independently established,
   remove that specific verified private root. Do not delete original pi session
   folders or use blanket recursive cleanup. Leave unverifiable/foreign roots
   intact for investigation, then retry recovery after resolving the error.

This does not promise automatic erasure of every hard-kill orphan. Directory
fsync support is required; unsupported filesystem operations fail. Synthetic
phase/race tests are not an all-platform power-loss qualification.

The result reports affected ordinary recipient sessions, which are never
deleted by Brain. Backups, provider-held data, delivered copies and files whose
ownership cannot be validated are outside a universal-erasure guarantee.

## Local embeddings and retrieval limits

The only embedding model is `onnx-community/embeddinggemma-300m-ONNX`, revision
`5090578d9565bb06545b4552f76e6bc2c93e4a66`, Q4/768 dimensions. Its five required
files total **218,726,989 bytes**. Explicit download follows the linked
[Gemma terms](https://ai.google.dev/gemma/terms) and
[prohibited-use policy](https://ai.google.dev/gemma/prohibited_use_policy).
Staging checks exact byte sizes and SHA-256 hashes before installation; startup
revalidates assets and performs a runtime self-test. Failed verification never
falls back to another model.

Transformers.js 4.3.2 uses native ONNX Runtime 1.30.0 on CPU in a separate utility
process, with local-only loading, network fetching disabled, fixed retrieval
prefixes, normalized vectors and a 512-token input limit. Only darwin-arm64 is
enabled; other platforms report unsupported. There is no WASM, hosted or
alternative-model fallback. Missing vectors yield explicitly degraded lexical
and typed-graph retrieval instead. Packaging and redistribution limits are in
[Desktop build](desktop-build.md#resources-and-release).

Retrieval filters scope, branch and temporal eligibility before ranking and
traversal. It combines exact aliases, FTS5, local-vector reciprocal-rank fusion
and bounded typed one/two-hop traversal. No hidden agentic search or reranker
runs. Token/result budgets can omit otherwise eligible results.

The frozen synthetic comparison uses 27 manually authored claims and 40 queries,
not customer data or real extraction output. At the default 4,000-token budget:

| Measure                                    | Lexical + graph (A) | Hybrid + graph (B) | Raw-transcript FTS5 |
| ------------------------------------------ | ------------------- | ------------------ | ------------------- |
| Claim top-1, 32 answerable queries         | 20/32               | 21/32              | Not comparable      |
| Evidence top-1                             | 24/32               | 25/32              | 16/32               |
| Claim recall @5                            | 0.693               | 0.698              | Not comparable      |
| No-gold queries returning nothing          | 1/8                 | 0/8                | 0/8                 |
| Measured scope/branch/temporal claim leaks | 0/0/0               | 0/0/0              | Not comparable      |

The one-query improvement is not statistically meaningful. Hybrid results were
budget-truncated to 2–3 claims; relationship top-1 was 0/5. Lexical stopword
matches weaken vector ranking, historical superseded claims lack vectors, and
there is no reliable abstention signal. The corpus, labels and scoring were
committed before scoring and were not tuned afterwards. See
[testing](testing.md#brain-acceptance) for reproducible harnesses and gate limits.
