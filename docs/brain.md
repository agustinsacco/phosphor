# Brain

Brain is Desktop's machine-local knowledge. It learns only from lanes you queue:
a private copy of the lane writes down what matters, you approve it, and agents
in every lane can recall it. It is off by default and Desktop-only; the browser
client and Hosts refuse every `brain:*` channel (`libs/shared/src/ipc-web.ts`).

## Turning it on

Settings → Brain works like Settings → Voice. One switch saves at once. Turning it
on downloads the pinned local embedding model, EmbeddingGemma 300M Q4
(`BRAIN_EMBEDDING_MODEL`, 208.6 MB), with a progress bar; the switch's description
links the Gemma Terms of Use. Once on, three rows appear:

- **Recall in lanes** (default on): new lanes get the `brain_search` tool and the
  bundled `brain` skill. Lanes already running pick it up when restarted.
- **Review before saving** (default on): extracted memories wait for approval.
  Off approves them as soon as extraction finishes.
- **Knowledge**: counts and an Open Brain button.

Turning Brain off keeps the model and all knowledge, stops the queue and removes
recall from new lanes. **Remove model** appears only while Brain is off and the
model is on disk. The Brain item shows in the sidebar's top navigation only while
Brain is on. Its page has no settings of its own; its Settings button opens this tab.

## Queueing a lane

Right-click a local lane and choose **Queue for knowledge extraction**. There is no
cost dialog; a queued, waiting or running lane offers **Cancel knowledge
extraction** instead. The queue (`libs/brain-runtime/src/queue.ts`) runs one lane
at a time and only while the embedding model is ready. A lane whose agent is
working (`SessionActivity.busy`) waits until it is idle. A lane with nothing new
since its last finished extraction is refused. Jobs left running when the app quit
go back to the queue.

## The private fork

A job reads the lane's session file for its cwd, last model and thinking level,
and its leaf, and asks git for the project root (the main checkout of a worktree)
and branch. It then runs pi in print mode on a fork of that file:

```
pi -p --mode json --fork <lane.jsonl> --session-dir <userData>/brain/forks/<job>
   --model <provider/id> --thinking <lane level, at most low> --no-tools --no-mcp
   --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve
   --offline -e brain-fork-guard.mjs "<extraction instruction>"
```

The fork uses the lane's own provider, model, binary, environment and Claude
account, run as a one-shot (`claudeOneShotEnv`: no keepalive, ephemeral) with a
private `PI_CLAUDE_CLI_STATE_DIR`.
It has no tools: `--no-tools` declares none, the guard extension refuses any tool
call, and `pi-claude-cli` runs Claude Code with `--tools ""`. The lane's file is
only read. The fork directory is deleted when the run ends. A run that takes
longer than 300 seconds fails; the target is under a minute, which is why
thinking is capped at `low`. The longer cap avoids discarding already-billed work
on large lanes. The fork sends the whole conversation to the lane's provider once
more, at that provider's price.

The app's `brain` log follows each job through start, fork completion, parsing,
quote verification, embedding and proposal. Each step carries the job ID, model,
capped thinking level and lane file bytes. A single `Brain extraction failed`
line records the failed phase, including cancellation and timeout; metadata not
yet read is null. Cancelling a job before it runs writes `Brain job cancelled`
with its job ID, model and queued/waiting phase, without a trace. Review and inbox
dismissal do not count as cancellation. `Brain extraction finished` remains the
success summary.
The fork trace records milliseconds to first stdout, first assistant
`message_start` and first `message_update` (time to first token), update and turn
counts, retries (attempt, delay and scrubbed error), compaction events, final
assistant stop reason and usage, total duration and completion reason. It never
records transcript, thinking or answer text. Provider diagnostics are scrubbed
with the evidence scrubber before clipping to 600 characters; stderr capture is
capped at 4096 bytes and appears only on failure. Stored timeout errors name the
model and say whether no reply arrived, a reply started, or pi was retrying with
a scrubbed provider error. No fork files are retained, even on failure. A local extraction record retains the
instruction, scrubbed final answer and trace for inspection (see below).

The instruction (`libs/brain-runtime/src/prompt.ts`) asks for at most 20 durable,
self-contained memories and 15 new entities: decisions with reasons, hard-won
facts about people and systems, stated preferences, procedures and pitfalls,
open risks. It lists what Brain already knows about the lane (memories it
recalled, memories learned from it before, and others in its project) and the
existing entities, and forbids restating them or extracting recall output. A
changed fact names the memory it `supersedes`.

## From answer to proposal

`libs/brain-runtime/src/extraction.ts` parses the JSON answer and drops items
outside the vocabulary. A link between two entities stays only when the sentence
names both; otherwise it becomes a plain fact about the subject.
`quotes.ts` verifies each memory's one or two quotes against the lane's transcript
(messages, tool output, tool call arguments and summaries): exact, then
whitespace-tolerant, then normalised. Results from `brain_search` (and
`brain_related` in lanes from before it was folded in) are excluded: recalled memories cannot serve as their own fresh evidence. The
instruction asks for an existing memory again only when the lane independently
states or relies on it, backed by a fresh lane quote; changed facts use
`supersedes`. A memory with no verified quote is dropped.
Evidence keeps up to 400 characters around each quote, so memories outlive their
lane; secrets and email addresses in it are replaced with `[redacted]`. The kept
sentences are embedded. At cosine similarity 0.86 or more, a candidate matching
an active memory becomes a **re-confirmation**, with its new citations and
evidence held in the proposal, not applied yet. A candidate matching an earlier
candidate in the same answer is a duplicate; it is counted separately from
re-confirmations.

## Review

The Brain page is one view. Its left pane lists the inbox (waiting, queued,
running, to review, nothing new, failed) and then approved memories grouped by
type, with a search box. Its right pane shows the open review, otherwise a
live 3D force graph of the approved memories with the selected memory below it.
The graph loads `3d-force-graph` (Three.js) lazily, only on a supported Brain page.
Nodes are entities mentioned by at least one active memory, coloured by kind with
a legend. Their bubble volume is `1 + memories + degree`: memories counts each
mentioning memory once, and degree counts distinct linked neighbours. Radius is
proportional to its cube root. Links aggregate each unordered entity pair, grow
thicker with memory count, and hold sorted unique predicates; self-links and
unknown endpoints are omitted. Literal-only entities remain in the cloud.
The largest twenty nodes always have sprite labels; hovering reveals other
labels, highlights neighbours and shows connected predicates while dimming the
rest. Drag nodes to move them, or drag the background to orbit. Zoom controls and
Fit adjust the camera. After its first layout settles, the graph fits the pane
with 16 px padding. Fits use the node spheres themselves, not the library's
`zoomToFit`, which fits the 3D bounding box's empty corners and leaves the
graph small. Container resizing instantly re-frames whatever the camera
shows (everything, the search matches or an About focus) unless the user moved
the camera. Fits never come closer than 250 units, so one match is not magnified. Refreshes preserve known positions. Memory search keeps
matching memories' entities bright and fits them in about 600 ms; clearing it
fits everything. An About chip flies to its entity. Keyboard users can focus the
same entities through the graph's screen-reader-only list; a small visible chip
names just the currently keyboard-focused entity.
Reduced motion precomputes the layout and disables camera transitions. Rendering
pauses after cooling and camera movement, and wakes on input or data changes.
Colours come from theme tokens and update on light/dark changes. If WebGL2 is
unavailable or graph initialization fails, a quiet message replaces the graph;
the memory list and keyboard entity focus remain usable.
A review lists every proposed memory, checked, with its quotes; **Approve N**
stores the checked ones in one transaction and **Reject all** stores none. Nothing
is searchable until it is approved. A review opened before another change to Brain
is refused, and must be reopened. **Forget** deletes one memory, then any evidence
and entities nothing else uses.

A mixed review also shows **Also confirms N existing memories**, with their
sentences. Approving any new memories applies all those confirmations, appending
their evidence/citations to the existing memories; rejecting everything applies
none. Confirmation-only jobs stay in review with **Confirms N existing memories**
and **Approve confirmations**. Review off auto-applies these too. A memory's
`observedAt` moves forward to the latest cited time, without changing its original
approval or effective date.

## Inspecting an extraction

**View extraction** on a memory, review (including a failed review load), or
failed/empty inbox job opens a read-only right-pane detail. Back returns to its
caller. It loads on demand and offers Retry after a failed load. The detail shows
lane/model/thinking, duration and time, outcome counts and every candidate's
result, links to produced or re-confirmed memories, the raw final answer with
Copy (JSON is pretty-printed; other text is unchanged), a collapsed instruction, and trace metrics (first token, turns, retries and
errors, stop reason, token usage). Invalid shapes and candidates without verified
quotes have explicit drop reasons. A link rewritten to a plain fact is kept with
**link check rewritten**, not falsely labelled dropped. Kept means kept in the
proposal, not necessarily approved.

**Source lane at extraction** is a collapsed, on-demand transcript through the
recorded clone leaf, including that leaf and excluding later entries; where parent
links exist it follows that leaf's ancestry. It returns the last 300 segments,
each scrubbed and clipped to 4,000 characters. This uses the evidence reader,
so Brain tool results are omitted here too. **Open lane** uses current sidebar
metadata/navigation, including retained-history handling for removed worktrees.
A deleted lane has no segments and no Open action; the extraction and stored
quotes still work.

`brain:extraction(jobId)` is Desktop-only and returns `BrainExtractionView`: the
record, produced memory ids/summaries, and
`source: { sessionPath, title, leafId, exists, segments }`. Job ids are validated
like other Brain requests. Browser and Host bridges refuse this channel.

Every run that reaches the private fork writes one local record, even on timeout,
provider error, invalid answer, or later processing failure. Runs failing before
the fork have no record. Records hold `jobId`, session id/path/title/leaf, model,
capped thinking, the exact extraction instruction, scrubbed raw final text, trace,
per-candidate outcomes (proposal index, re-confirmed memory, duplicate target, or
drop reason), error, and start/finish times. Raw answers are capped at 256 KB with
an explicit truncation marker; transcript/answer text never enters diagnostic logs.

A record is retained while its job is in the inbox or any memory references it.
Dismissal/rejection deletes it if no memories reference it; Forget deletes it when
the last reference goes away and the job is no longer in the inbox. All records
expire after 30 days regardless of references, cleaned on startup and Brain reads
or mutations. Approved memories and their evidence never expire with the record;
an expired View extraction reports that the record is gone.

## Storage and graph

`<userData>/brain/brain.sqlite` (`libs/memory-engine`) holds settings, the queue,
proposals, extractions, entities, memories, evidence, citations, vectors and recall
deliveries. Schema version 3 migrates v2 in place, adding nullable `memories.job_id`
and the `extractions` table without losing approved knowledge, queue or settings.
Older prototype versions still reset. Approved new memories carry their extraction
job id; migrated memories have none. Re-confirmation retains the memory's original
job id. The agent-facing recall text is unchanged.
The model lives under `<userData>/brain/embeddings`. On startup Brain deletes what
the earlier prototype wrote (`memory.sqlite`, `evidence/`, `learning/`, `sessions/`),
since nothing can read or show it.

The graph follows the property-graph practice of Neo4j's knowledge-graph builder,
Microsoft GraphRAG and Graphiti: a small fixed schema of node labels and
relationship types, facts stored as sentences on edges, provenance kept per fact.

- Entities (`BRAIN_ENTITY_KINDS`): person, team, organization, project, component,
  document, concept, event. They are shared across projects and merge by kind and
  folded name or alias.
- Memories (`BRAIN_PREDICATES`): owns, works_on, member_of, part_of, depends_on,
  uses, decided, prefers, blocks, affects and related_to link two entities;
  `about` attaches a literal fact to one.
- Types (`BRAIN_MEMORY_TYPES`): decision, open, risk, procedure, preference, fact.
  Each memory also records how it is known (observed, reported, inferred), its
  project, its branch when it only holds there, and the lane it came from.

## Recall

When Brain and recall are on, lane startup (`SessionStartupRuntime.recall`) adds
`PHOSPHOR_BRAIN_ENDPOINT`, `PHOSPHOR_BRAIN_TOKEN`, `-e brain-ext/brain.mjs` and
`--skill skills/brain`. The endpoint is a local socket; the token is random per
app run. Recall never blocks a lane: any failure starts it without Brain. The
one tool only reads.

`brain_search(query, limit?)` returns 8 memories by default, up to 20:

- **Named entities.** An entity is named when its name or an alias appears in the
  query as whole words, or the query appears in its name: "NRS" names every NRS
  project, "Rina" names Rina Okafor, and "Harbor" never names Harborview. Common
  words alone name nothing. Every memory about a named entity is a match.
- **One hop out.** Subject→object memories that touch a named entity are its
  links, up to eight. Memories about the entity at the other end match at half
  weight, so they rank below the named ones.
- **Ranking** is meaning first. Semantic matches need cosine 0.35 or more; word
  matches use BM25 without common words. Reciprocal rank fusion weighs meaning,
  words, named entities and neighbours 2, 1, 1 and 0.5, and the lane's own project
  counts 1.25 times. Age then reorders: a memory's score
  falls toward half its weight as the later of its latest cited time (`observedAt`)
  and effective date (`validFrom`) gets older; a future effective date is ignored
  for aging. It
  reaches three quarters after 30 days for an open question, 60 for a risk,
  180 for a decision or fact and 365 for a procedure or preference. Nothing
  expires: an old memory is still found when nothing newer matches. No match
  returns nothing. Without the model, search falls back to words and names and
  says so.
- **What was left out.** `more` counts strong matches (a named entity or shared
  words) beyond the limit, not loose semantic matches or neighbours. The briefing
  adds any hit its 6,000-character budget dropped.

Every memory carries three dates: `observedAt`, when its lane said it (its latest
cited transcript entry, else the approval time); `recordedAt`, when it was
approved; and `validFrom`, when it took effect, only if the lane named one. The
Brain page shows how long ago each was said.

The tool returns one briefing, never evidence text:

```text
About: Harbor billing (project, also SKT-100)
Links: Rina Okafor owns Harbor billing
Risks:
- Invoices retry three times before paging. · harbor (this project) · 2026-11-07
Open, may have changed since:
- …
Decisions: / Facts: / How things are done: / Preferences:
- …
3 more matches not shown. Search again with a higher limit (up to 20) or a narrower query.
See also: Rina Okafor, Tom Lee. Search a name to see what Brain holds about it.
```

Each line gives the project, the date said and any effective date. Sections come
in that order, so what to watch for comes first; empty ones are left out. It is
wrapped in `<background-data authority="none">`, with `&`, `<` and `>` escaped. Each
delivery is recorded, so a later extraction of that lane skips what it recalled.
The skill tells agents to search by name or short topic before "what do we know
about…" answers, in unfamiliar areas, before settled decisions and before writing
to someone about a project, to follow See also when it matters, to treat another project's
memories as context, not rules, and to trust the newer memory when two disagree.

## Limits

- Extraction quality is the lane model's. A wrong link or sentence is caught only
  by review, or by Forget afterwards.
- Entities merge only on exact folded names or aliases.
- Desktop only, one machine. Nothing syncs between machines or to Hosts.
