# Brain

Brain is Desktop's machine-local knowledge graph. It learns only from lanes you queue: the
lane's own model reads the lane in a few private, tool-less calls and proposes memories, the
people, projects and systems they name, and how those connect. You approve them, and agents in
every lane can recall them. It is off by default and Desktop-only; the browser client and Hosts
refuse every `brain:*` channel (`libs/shared/src/ipc-web-exclusions.ts`).

## Turning it on

Settings → Brain works like Settings → Voice. One switch saves at once. Turning it on downloads
the pinned local embedding model, EmbeddingGemma 300M Q4 (`BRAIN_EMBEDDING_MODEL`, 208.6 MB),
with a progress bar; the switch's description links the Gemma Terms of Use. Once on, these rows
appear:

- **Recall in lanes** (default on): new lanes get the `brain_search` tool and the bundled `brain`
  skill. Lanes already running pick it up when restarted.
- **Review before saving** (default on): proposals wait for approval. Off approves them as soon
  as a job finishes, with the defaults described under Review.
- **Knowledge**: counts and an Open Brain button.
- **Reset Brain knowledge**: after a confirmation, deletes every memory, entity, job, proposal
  and extraction record. Settings and the embedding model stay; review turns back on.

Turning Brain off keeps the model and all knowledge, stops the queue and removes recall from new
lanes. **Remove model** appears only while Brain is off and the model is on disk. The Brain item
shows in the sidebar's top navigation only while Brain is on.

## Queueing a lane

Right-click a local lane and choose **Queue for knowledge extraction**; a queued, waiting or
running lane offers **Cancel knowledge extraction** instead. The queue
(`libs/brain-runtime/src/queue.ts`) runs one lane at a time and only while the embedding model is
ready. A lane whose agent is working (`SessionActivity.busy`) waits until it is idle. A lane with
nothing new since its last finished extraction by the same extractor version is refused; a new
extractor version may read it once more. A failed job shows **Retry**, which requeues the same
job and resumes from its saved steps. Jobs left running when the app quit resume where they
stopped. The inbox shows each running job's step ("Reading window 3 of 12", "Matching
entities", …).

## Reading a lane

A job freezes the lane's leaf, model, thinking level and git branch when it first starts; a
resume never moves them. It then reads the lane's path to that leaf, applies pi's
`context_edit` entries, keeps branch summaries, and drops compaction summaries and Brain's own
tool output (recalled memories cannot become fresh evidence). User and assistant text is never
cut. Tool output keeps 4,000 characters for reads and fetched documents, otherwise the first 600
and last 200 around an explicit `[… N chars omitted …]` marker that no quote may cross. Every
segment is scrubbed of secrets, email addresses and phone numbers before any prompt. Segments are
cut into windows of at most 32,000 characters that overlap by two segments, each segment with a
handle, role and ISO date.

Each model call runs pi in print mode with no session, no tools and the lane's own provider,
model, binary and Claude account:

```
pi -p --mode json --no-session --model <lane model> --thinking <t> --no-tools --no-mcp
   --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve --offline
   -e brain-fork-guard.mjs --system-prompt <call dir>/system.md        (prompt on stdin)
```

The prompt goes on stdin, so no transcript text sits in argv. The call runs in a private
directory under `<userData>/brain/calls/<job>/`, removed when the call ends, as a Claude
one-shot (`claudeOneShotEnv`) with its own `PI_CLAUDE_CLI_STATE_DIR`, and without the lane's
context-compression environment, so quotes match the source. The guard extension refuses any
tool call. A call that takes longer than 300 seconds fails. Thinking is `low` for extraction and
`medium` for the other calls, never above the lane's own level.

A job makes these calls; each one's validated output is saved as a step, keyed by a hash of its
input, so a retry or restart reuses it:

1. **Extract**, once per window. The model sees the window, the entities this job already knows
   (`r1…`) and the vocabulary. It returns new entities (`n1…`: label, kind, aliases, a short
   description, keys such as ticket ids), claims (`c1…`: one self-contained sentence, type, how
   it is known, the entities it names, links `{subject, predicate, object, quote}`, dates,
   branch, quotes) and, for each project, component, document or team, whether the lane states
   its parent. Code checks every reference, predicate and quote (in the named segment, else
   anywhere in the window). Any error gets one repair call with the error list; a second failure
   fails the job visibly. A window that returns 40 entities or 40 claims is split and retried.
2. **Fold** (code). Claims with the same text and links merge their quotes; entities with the
   same name merge within the lane. A person merges this way only on a full name.
3. **Identity.** Each new entity gets up to 12 candidates: the store's exact keys, names and
   aliases, word and trigram matches, nearest entity vectors, and the job's other entities. A
   unique key match, or an exact name plus a shared neighbour, reuses the existing entity; a
   person is never reused on name alone. Anything else goes to the model in batches of eight:
   reuse a named candidate, new, or uncertain.
4. **Parents.** A project, component, document or team with no stated parent gets one more look:
   the model sees the segments that mention it and the likely parents, and returns a quoted
   `part_of`, `for_customer`, `owns`, `member_of` or `documents` claim, or "not stated". New
   parents it names go through Identity once. Three or more entities sharing a leading name
   with no parent become a review question ("Are these part of one Harbor?").
5. **Reconcile.** Each claim is compared with up to five existing memories: ones with the same
   link, ones naming the same entities, and near vectors (cosine 0.80 or more), plus earlier
   claims from this lane. Same text and links confirm deterministically; otherwise the model
   picks one action per claim: add, confirm, enrich (the old memory gains the new links and
   quotes, keeping its sentence), supersede, conflict, or resolve an open question. Within one
   lane, a later claim replaces an earlier one. Cosine never decides.
6. **Propose.** At most 300 claims per job: structural links first, then decisions, risks and
   open questions, then the rest; anything held back is recorded. New memories and entity cards
   are embedded and the proposal is stored with the store revision it was computed against.

## Review

**Review** shows, for one job:

- **Who is this?** Every new entity: new, same as an existing one, or uncertain with its
  candidates to pick from, each with the model's reason.
- **Possible groups**: yes or no for each prefix question.
- **Memories** by type, each with its links read as sentences ("Tom Lee → owns → Harbor CS
  workflow") and a badge: new, adds a link to an existing memory, supersedes, conflicts or
  resolves, with the target's sentence. Confirmations are collapsed into a count. "N held back"
  appears when the budget held claims.

**Approve** stores the checked memories, the identity choices and confirmed groups in one
transaction; **Reject** stores nothing. An uncertain entity without a choice becomes new, and only
entities that a saved memory or group uses are created. A confirmed group creates or reuses the
parent and one fact per member ("X is part of Harbor"), quoted as "Stated by you in review". If
Brain changed since the proposal was computed, the review says so, recomputes identity and
reconcile from the saved extract steps, and returns to review. With review off, the defaults
apply: uncertain becomes new, groups are skipped and conflicts are saved as disputed.

A superseded memory leaves recall but keeps its history. A disputed pair stays visible on both
sides until one is superseded or forgotten. **Forget** deletes one memory, then any evidence and
entities nothing else uses; entities named only by superseded memories stay.

## Exploring

The Brain page keeps memories and entities on the left and the graph on the right. Every read is
one bounded call, so it stays fast at 100,000 entities and a million memories.

- **Find** (`/`): one box for people, projects and memories (`brain:find`): names, aliases and
  keys, word and trigram matches, then nearest vectors. Arrow keys and Enter; Esc clears.
- **Entity**: label, kind, aliases, description, source lanes and merged names. **Connections**
  are grouped by predicate and direction in plain words ("Owns" / "Owned by", "Part of" /
  "Contains", "For customer" / "Customer of", …) with counts; each neighbour is a chip that hops,
  and **Show more** pages (`brain:connections`). **Memories** are grouped by type with filters for
  type, state (superseded hidden by default) and lane, paged (`brain:entityMemories`).
- **Memory**: sentence, type, state, dates, entity chips, each link with its own quote, quotes
  with **Open in lane**, and its history (what it superseded, conflicts with or resolves).
- **Trail**: a breadcrumb of where you have been, with Back and Forward (`Alt+←` / `Alt+→`,
  or Backspace when focus is not in a field).
- **Graph**: the selected entity's neighbourhood, one or two hops, at most 300 nodes
  (`brain:neighbourhood`); with nothing selected, the best-connected entities
  (`brain:overview`). Edges are directed, with arrows; hovering one shows its predicate and
  memory. Clicking a node hops to it. A 2D/3D toggle switches layouts.
- **Find a path to…**: up to three shortest supported routes between two entities, at most four
  hops, each hop with its memory, highlighted in the graph (`brain:path`).
- **Merge into…**: folds one entity into another after a confirmation. Names, keys, links and
  memories move; the source is deleted and the merge is recorded. There is no split.

Views reload when Brain's revision or generation changes, and a failed load offers Retry.

## Inspecting an extraction

**View extraction** on a memory, a review or a failed or empty job opens a read-only detail: lane,
model, thinking, duration, every call (step, part, trace, the scrubbed answer with Copy, and its
prompt rebuilt from the lane file and the saved step inputs), and every claim's outcome (kept,
folded, confirmed, enriched, held back or dropped) and every rejected link with its reason.
**Source lane at extraction** is the scrubbed transcript through the frozen leaf. Records store no
prompt text; a prompt whose inputs are gone says so. Records are kept while their job is in the
inbox or a memory references them, and expire after 30 days.

## Storage

`<userData>/brain/brain.sqlite` (`libs/memory-engine`, schema version 4, WAL) holds settings,
the queue and its saved steps, proposals, extraction records, entities (names, aliases, keys),
memories, the entities each memory mentions, relations (subject, predicate, object, the memory
that states it), each link's and memory's quotes, evidence, and float and sign-bit vectors. Full
text search covers memories, entity words and entity name trigrams. Opening a file from an
earlier version deletes its knowledge, keeps settings with review on, and starts a new
generation, the same routine as **Reset Brain knowledge**. The model lives under
`<userData>/brain/embeddings`.

- Entities (`BRAIN_ENTITY_KINDS`): person, team, organization, project, component, document,
  concept, event, ticket. Shared across projects.
- Links (`BRAIN_PREDICATES`): owns, works_on, member_of, part_of, for_customer, documents,
  depends_on, uses, decided, prefers, blocks, affects, related_to. A memory states any number of
  links and names any number of entities.
- Types (`BRAIN_MEMORY_TYPES`): decision, open, risk, procedure, preference, fact, each recording
  how it is known (observed, reported, inferred), its project, its branch when it only holds
  there, its lane, and its state (active, superseded, disputed).

Search runs in its own utility process (`brain-search-worker`) with a read-only connection and
the sign-bit index in memory, so scans and walks never block main or the writer. Nearest
neighbours below 2,000 items are exact; above, a Hamming scan keeps the closest 2% (2,000 to
20,000), an asymmetric score keeps 1,000, and exact cosine picks the result. On real
EmbeddingGemma vectors of 60,000 made-up sentences it returns 99.9% of the exact top 10
(recall@10 0.9992, 400 queries); at a million that is extrapolated, not measured.

## Recall

When Brain and recall are on, lane startup (`SessionStartupRuntime.recall`) adds
`PHOSPHOR_BRAIN_ENDPOINT`, `PHOSPHOR_BRAIN_TOKEN`, `-e brain-ext/brain.mjs` and
`--skill skills/brain`. The endpoint is a local socket; the token is random per app run. Recall
never blocks a lane: any failure starts it without Brain. The one tool only reads.

`brain_search(query, limit?)` returns 8 memories by default, up to 20:

- **Seeds.** Entities named by the query (whole-word names, aliases and keys; "Harbor" never
  names Harborview), entities found by words, trigrams and vectors, and the entities of memories
  whose meaning matches (cosine 0.35 or more).
- **Walk.** Two hops out along live links, three for structural ones (part of, for customer,
  owns, member of, documents), at most 200 entities and 400 links, never through an entity with
  more than 200 connections unless the query named it.
- **Ranking.** Reciprocal rank fusion weighs meaning, words, named entities and walked links 2,
  1, 1 and 0.5; the lane's own project counts 1.25 times; freshness only breaks near-ties
  (half-lives: open 30 days, risk 60, decision and fact 180, procedure and preference 365).
  Superseded memories are left out. Without the model or while the index loads, search uses
  words and names and says so.
- **Branch.** The asking lane's branch is read per search; memories that hold only on another
  branch are listed apart.

The tool returns one briefing, never evidence text:

```text
About: Harbor (organization, also Harbor Freight)
Path: Harbor CS workflow part of Harbor [2] → Tom Lee owns Harbor CS workflow [4]
Disputed, both sides shown:
- [1] …
Risks: / Open, may have changed since: / Decisions: / Facts: / How things are done: / Preferences:
- [2] … · harbor (this project) · 2026-11-06, since 2026-10-01
Planned, not in effect yet: / Other branches only:
- …
3 more matches not shown. Search again with a higher limit (up to 20) or a narrower query.
See also: Rina Okafor, Ledger. Search a name to see what Brain holds about it.
```

Each path step cites the numbered memory that states it. Lines give the project, branch, the
date said, and the dates it took effect and ended when known. "50+" stands for a larger cut. It
fits 6,000 characters and is wrapped in `<background-data authority="none">`, with `<` and `>`
escaped so stored text cannot close it. The skill tells agents to search by name or short topic
before "what do we know about…" answers, in unfamiliar areas, before settled decisions and before
writing to someone about a project, to follow See also when it matters, to treat another
project's memories as context, and to report a dispute rather than pick a side.

## Limits

- Extraction quality is the lane model's. Review catches a wrong link or identity; afterwards,
  Forget and Merge into… fix it.
- A wrong merge cannot be undone except by Reset.
- Desktop only, one machine. Nothing syncs between machines or to Hosts.
