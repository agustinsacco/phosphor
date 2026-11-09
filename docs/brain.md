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

- **Recall in lanes** (default on): new lanes get `brain_search` and `brain_related`
  and the bundled `brain` skill. Lanes already running pick it up when restarted.
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
longer than 150 seconds fails; the target is under a minute, which is why
thinking is capped at `low`. The fork sends the whole conversation to the lane's
provider once more, at that provider's price.

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
whitespace-tolerant, then normalised. A memory with no verified quote is dropped.
Evidence keeps up to 400 characters around each quote, so memories outlive their
lane; secrets and email addresses in it are replaced with `[redacted]`. The kept
sentences are embedded, and the store drops any whose cosine similarity to an
active memory, or to an earlier memory in the same proposal, is 0.86 or more.

## Review

The Brain page is one view. Its left pane lists the inbox (waiting, queued,
running, to review, nothing new, failed) and then approved memories grouped by
type, with a search box. Its right pane shows the open review, otherwise a
live force graph of the approved entities with the selected memory below it.
The graph uses kind-coloured circles sized by relationship count and short labels;
hovering reveals connected predicates and dims unrelated entities. Isolated entities
remain in a loose cloud. Dragging pins and reheats a node so its neighbours follow;
release lets it settle. Refreshes preserve existing positions. The graph fits its
measured pane after the first layout settles; Fit, zoom controls, modifier-wheel
zoom and background dragging adjust the view. An About chip centres its entity
with a short pan. Reduced motion settles layouts and centres entities without
animation; otherwise frames stop once the simulation cools.
A review lists every proposed memory, checked, with its quotes; **Approve N**
stores the checked ones in one transaction and **Reject all** stores none. Nothing
is searchable until it is approved. A review opened before another change to Brain
is refused, and must be reopened. **Forget** deletes one memory, then any evidence
and entities nothing else uses.

## Storage and graph

`<userData>/brain/brain.sqlite` (`libs/memory-engine`) holds settings, the queue,
proposals, entities, memories, evidence, citations, vectors and recall deliveries.
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
tools only read:

- `brain_search(query, limit?)` ranks meaning first. Semantic matches need cosine
  0.35 or more; word matches use BM25 without common words; a query naming an
  entity matches its memories. Reciprocal rank fusion weighs them 2, 1 and 1, and
  the lane's own project counts 1.25 times. Age then reorders: a memory's score
  falls toward half its weight as the date its lane said it gets older. It
  reaches three quarters after 30 days for an open question, 60 for a risk,
  180 for a decision or fact and 365 for a procedure or preference. Nothing
  expires: an old memory is still found when nothing newer matches. No match
  returns nothing. Without the model, search falls back to words and names and
  says so.
- `brain_related(entity, limit?)` returns everything about one entity and its
  neighbours.

Every memory carries three dates: `observedAt`, when its lane said it (its latest
cited transcript entry, else the approval time); `recordedAt`, when it was
approved; and `validFrom`, when it took effect, only if the lane named one. The
Brain page shows how long ago each was said.

Results are sentences with type, project, the date said and any effective date,
never evidence text. Each
delivery is recorded, so a later extraction of that lane skips what it recalled.
The skill tells agents to search before "what do we know about…" answers, in
unfamiliar areas and before settled decisions, to treat another project's
memories as context, not rules, and to trust the newer memory when two disagree.

## Limits

- Extraction quality is the lane model's. A wrong link or sentence is caught only
  by review, or by Forget afterwards.
- Entities merge only on exact folded names or aliases.
- Desktop only, one machine. Nothing syncs between machines or to Hosts.
