# Brain

Brain is Desktop's machine-local knowledge graph. It learns only from lanes you queue: the
reader model reads the lane in a few private, tool-less calls and proposes memories, the
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
- **Model that reads lanes** (default **Each lane's own model**): choose one provider/model for
  every queued lane, including lanes without a model. A job keeps the model it first starts with,
  even after this setting changes or you Retry it. Use **Use each lane's own model** to clear it.
  A stored setting is checked when read as well as when written: a malformed value reads as its
  default.
- **Knowledge**: counts and an Open Brain button.
- **Reset Brain knowledge**: after a confirmation, deletes every memory, entity, job, proposal
  and extraction record. Settings and the embedding model stay; review turns back on.

Turning Brain off keeps the model and all knowledge, stops the queue and removes recall from new
lanes. **Remove model** appears only while Brain is off and the model is on disk. The Brain item
shows in the sidebar's top navigation only while Brain is on.

## The Brain page

The page header shows **Brain**, “N memories · M people and things”, and Settings.
Underlined **Knowledge**, **Lanes** and **Tidy** tabs separate exploration, reading and review,
and knowledge cleanup. Tidy is available only while local Brain is on.
Arrow keys, Home and End select tabs. Knowledge opens first, except when there are no
memories and at least one job: then Lanes opens. Switching tabs keeps the explorer trail
and selected lane; explorer shortcuts act only on Knowledge. The Lanes tab and the sidebar's
Brain row show the live count of jobs waiting for review, hidden at zero.

Lanes is a plain list beside the selected lane's detail, with nonempty sections:

- **To review**: proposed memory count, reader model name, and “reading again” on replacements.
- **Reading**: running first, then queued, then waiting for the lane to be idle. A running row
  has the working beacon and its reported step.
- **Failed**: a shortened error on the row; the detail wraps the full error and offers Retry
  and Dismiss.
- **Read**: quieter rows from the newest finished reads, with memory count (or “Nothing kept”),
  model name and relative finish time. Empty jobs join these rows by finish time as “Nothing
  kept”; they offer Dismiss, never Read again.

Selection follows the same job from reading through review into history. If it disappears,
Brain chooses a review first, then a reading job, then a finished read (or a failed job when
that is all that remains). Actions belong to the detail, not the list rows. With nothing to
show, the list says “Right-click a lane and choose Queue for knowledge extraction.”

A reading detail shows its model, elapsed time or queue line, Cancel, and the reported
steps: Prepare, Read the conversation (part x of y), Match people and things, Compare with
what Brain knows, and Index. It never invents a separate live relationship stage; **Find
relationships** names the recorded links calls. Calls made so far use the same closed
call disclosures as a finished read. Until the first record is saved it says “No calls yet.”,
without an error notification. Once a record exists, reading and failed details also show the
same candidate outcomes and reasons and **Source lane at extraction** (with Open lane) as a
finished read. Every real load failure offers Retry.

### Tidy

Tidy's tab badge counts open suggestions. Like Lanes, it keeps a grouped list beside the
selected detail. **Same person or thing?**, **Said twice**, **These disagree** and **Flagged by a
lane** show their counts and reasons; empty groups disappear. Show more loads twenty more
suggestions. Up and Down move between rows and Enter opens one. Switching tabs preserves the
selection and comparison controls, alongside the Knowledge trail and selected lane.

**Tidy now** looks for repeats locally, then asks the reader model to judge at most forty pairs.
Its tooltip names the pinned reader, or the newest finished read's model. The status line shows
local work, model progress, the last coverage and partial coverage. Cancel stops a run. A
cancelled, failed, skipped (no model to check with) or interrupted (Phosphor closed mid-run) run
shows its reason and Retry. No cost or token counts appear.

A comparison starts with its reason and whether a local rule or the named model found it.
Entities show descriptions, other names, memory counts, links and source lanes. Memories show
scope, branch, dates and labelled quotes. The two sides stack when the comparison pane is narrow;
each opens its record on Knowledge. Entity merges default to the record with more memories and
have a **Swap surviving record** control. Both “Said twice” and “These disagree” offer the actions
the engine currently allows: either memory can survive a fold, both can stay disputed, or either
side can replace the other. Different project, branch or dates, or existing replacement/dispute
history, prevent folding; a quiet line shows the engine's reason. **Not the same** dismisses an
open suggestion. A lane flag offers **Keep**, or a confirmed permanent **Forget**. It names the
flagging lane as Phosphor's own lane list does; a lane missing from that list shows as “A lane
calling itself …”, because the title came from the flag. Open the lane resolves only a local lane
already known to the sidebar, never a path supplied by the flag.

A decision selects the next visible suggestion. Successful changes offer Undo in their toast.
**Recent changes** lists the newest fifty journal operations with their time, automatic/by-you
origin and Undo. Refused undo shows the engine's reason. Failed actions reload rather than replay:
a changed revision says “Brain changed. Check this again.”; an already-settled suggestion advances
to the next. Every failed read offers Retry, and older replies cannot overwrite newer reads.

Automatic folds produce one “Brain folded N exact repeats” toast and panel notice opening Recent
changes. New suggestions replace the single `brain:tidy` notice: “Brain has N things to tidy”.
A completed Tidy run announces its result only while Tidy is not visible. Notices open Brain on
Tidy. Existing startup suggestions and decreasing counts are silent; disabling Brain removes its
Tidy notices. While visible, enabled Brain checks status every ten seconds to discover lane flags,
or every two seconds during work. These reads never start a sweep or a model call.

## Queueing a lane

Right-click a local lane and choose **Queue for knowledge extraction**; a queued, waiting or
running lane offers **Cancel knowledge extraction** instead. The queue
(`libs/brain-runtime/src/queue.ts`) runs one lane at a time and only while the embedding model is
ready. A lane whose agent is working (`SessionActivity.busy`) waits until it is idle. A lane with
nothing new since its last finished extraction by the same extractor version is refused; a new
extractor version may read it once more. A failed job shows **Retry**, which requeues the same
job and resumes from its saved steps. Jobs left running when the app quit resume where they
stopped.

## Read lanes and Read again

The **Read** section of Lanes shows the newest 200 finished reads, with one history row per
lane, and says when more exist. The list reloads when jobs or knowledge change; a failed load
has Retry. Model names match the picker; unavailable names fall back to the id without its
provider prefix. A row opens the finished read in the same pane.

**Read again** in a finished read reads the whole lane, even if nothing changed.
It confirms how many earlier memories will be replaced. Memories another lane also supports
are kept. The lane must still be readable and have no queued, running or review job. Busy lanes
wait as usual; leaf and model freeze at first start. Retry keeps the replacement intent.

Earlier memories remain searchable while the new read runs and waits for review. Reconcile
excludes the memories this read will replace; entity identity still reuses shared entities.
Approval saves the checked candidates and removes the earlier, unshared memories from that lane
in one transaction, including memories from older reads whose job rows are gone. Partial
approval, or approval with no candidates checked, still replaces them. With review off, saving
happens immediately. A citation or relationship supported by a different lane protects its
memory unchanged. Entries a fork copied from its source lane are the same evidence, not another
lane's support; a message written in the fork is. Replacing bumps the revision once. If the
search index fails to refresh after an automatic save, the read still ends as done and the
failure is logged. A rejected, cancelled or permanently failed reread removes no knowledge.
An **empty** reread (nothing kept) also removes nothing. Rejecting or dismissing a reread keeps
the earlier finished read in history. Successful saving replaces that history row.

## Reading a lane

A job freezes the lane's leaf, chosen reader model, thinking level and git branch when it first
starts. A resume never moves them. It then reads the lane's path to that leaf, applies pi's
`context_edit` entries, and keeps only user and assistant text. Tool calls, tool output,
custom messages, branch summaries and compaction summaries are not evidence. Every segment is
scrubbed of secrets, email addresses and phone numbers before any prompt. User messages longer
than 6,000 characters keep their first 4,000 and last 1,900 around an explicit
`[… N chars omitted …]` marker. Assistant text is never elided. No quote may cross a marker.

The conversation is read in parts of at most 300,000 characters, with two segments of overlap.
Each segment has a handle, role and ISO date. Most lanes fit in one part. A part can be about
100,000 tokens. A reader model with a smaller context window fails with the provider's error.

Each model call runs pi in print mode with no session and no tools. It uses the chosen reader
provider and model, or the lane's own model when unset. The binary and Claude account come from
the lane:

```
pi -p --mode json --no-session --model <reader model> --thinking <t> --no-tools --no-mcp
   --no-skills --no-prompt-templates --no-context-files --no-themes --no-approve --offline
   -e brain-fork-guard.mjs --system-prompt <call dir>/system.md        (prompt on stdin)
```

The prompt goes on stdin, so no transcript text sits in argv. The call runs in a private
directory under `<userData>/brain/calls/<job>/`, removed when the call ends, as a Claude
one-shot (`claudeOneShotEnv`) with its own `PI_CLAUDE_CLI_STATE_DIR`, and without the lane's
context-compression environment, so quotes match the source. The guard extension refuses any
tool call. A call that takes longer than 600 seconds fails. With a reader model selected, thinking
is `medium`. Otherwise it uses the lane's level, capped at `medium`. An unknown level also uses
`medium`.

A job calls extract, links, identity and reconcile. Each call's validated output is saved as a
step, keyed by a hash of its input, so a retry or restart reuses it:

1. **Extract**, once per part. The model sees the conversation, the entities this job already
   knows (`r1…`), and the claim sentences kept from earlier parts. The prompt assumes any work
   session, not only a coding one. Both speakers are evidence: the user's messages are
   first-hand, and the assistant's replies report what it found in code, data, documents and
   tools. Only the assistant's account of its own work is skipped. A claim is kept if a future
   session would act differently, it would take real digging to learn again, and it will
   probably still hold in a month or records a decision with its reason. Each part keeps every
   claim that passes, up to 25; an empty answer is valid only when nothing passes. Extra claims
   are dropped with a recorded reason. No kind of claim ranks first. The model looks for people
   and structure (who is on which team, who leads, owns or decides what, which customer a
   project is for), how systems, vendors, data and customers behave, decisions with reasons,
   preferences and corrections, reusable procedures, remaining risks and open questions for a
   named person or team. A standing role passes; a ticket event does not. Status, one-off
   events, near-term dates, pull requests, code facts, file paths, the assistant's work log,
   instructions for one task, unaccepted proposals, corrected statements, generic advice,
   personal matters about a person (health, family, pay, performance, conduct), secrets and
   contact details do not pass.
   It returns lasting entities (`n1…`), self-contained claims (`c1…`) with one or two quotes,
   typed links with their own quotes, and parent assessments for new projects, components,
   documents and teams. A stated parent needs a kept structural link whose subject is that entity.
   Missing or invalid parent assessments mean not stated. People are humans, never agents or bots.
   Pull requests, tickets, commits, branches and files are not entities. The model is asked for
   every lasting relationship the conversation shows between a kept claim's entities. A link
   sits on a claim that mentions both ends, and its quote may come from any segment. A person is
   linked only for a real role, never to a tool they merely use. The answer rules are repeated
   after the conversation, because a long one buries them.
2. **Links**, after each part's extraction. The model sees only kept claims that mention two or
   more entities, those entities, existing links and short excerpts around each claim's quotes.
   Each excerpt stays in its segment, stops at an elision marker and adds at most 600 characters
   on each side. Overlapping excerpts merge. Links join two entities the claim already mentions,
   obey the same endpoint-kind rules and need their own verified quote from a claim excerpt's
   segment. Duplicate links are dropped. A new structural link can supply a previously unstated
   parent. When no claim mentions two entities, this call is skipped. Its validated result has a
   separate per-part checkpoint; the extraction checkpoint stays unchanged.
3. **Fold** (code). Claims with the same text and links merge their quotes; entities with the
   same name merge within the lane. A person merges this way only on a full name.
4. **Identity.** Each new entity gets up to 12 candidates: the store's exact keys, names and
   aliases, word and trigram matches, nearest entity vectors, and the job's other entities. A
   unique key match, or an exact name plus a shared neighbour, reuses the existing entity; a
   person is never reused on name alone. Anything else goes to the model in batches of eight:
   reuse a named candidate, new, or uncertain. Three or more entities sharing a leading name
   with no parent become a review question ("Are these part of one Harbor?"). No separate model
   call looks for parents.
5. **Reconcile.** Each claim is compared with up to five existing memories: ones with the same
   link, ones naming the same entities, and near vectors (cosine 0.7 or more), plus earlier
   claims from this lane. Earlier claims rank by same text, shared link pair, cosine at least
   0.7 (highest first), then shared entity. Paraphrases can match without shared entities.
   Same text and links confirm deterministically; otherwise the model picks add, confirm (same
   assertion, nothing new), enrich (same assertion, new supported links), supersede, conflict,
   or resolve an open question. Within one lane, a later claim replaces an earlier one.
   Cosine offers candidates but never decides.
6. **Propose.** At most 300 claims per job: structural links first, then decisions, risks and
   open questions, then the rest; anything held back is recorded. New memories and entity cards
   are embedded and the proposal is stored with the store revision it was computed against.

Parsing drops the smallest invalid item and records why. A bad entity or claim cannot fail a
lane. A bad link is dropped while its claim and known endpoint mentions remain. The first valid
ref wins. Quotes match exactly in the cited segment, then any segment, then with flexible
whitespace, straight/curly quotation marks and no Markdown emphasis marks (backticks, and
asterisks that touch text and are not inside a word or number, so `a*b` and `2 * 3` keep theirs),
by a linear search. Flexible matches store the source's own substring.
Every quote stays within one unelided span. Only unusable JSON or missing entity/claim arrays (or the links array in a links call)
gets one repair call; a second unusable answer fails visibly.

Identity and reconcile keep valid decisions and ask once more for undecided rows alone. The
accepted answer to each prompt is saved, so a retry asks only for rows it still lacks. Still
missing identity decisions become uncertain; missing reconcile decisions become add. Invalid,
duplicate and unoffered decisions cannot fail a lane. An unusable decision envelope gets one
repair call. A call that ends without a usable answer because the provider, the transport or the process
failed retries once after two seconds (`error`, `no-text`, `exit` or `spawn`). Abort, timeout and
output overflow do not retry. The trace keeps the actual failure reason. Each attempt has its own recorded call and input
checkpoint, and both attempts count toward usage.

## Review

The selected review opens with its lane title, reader model name and finish time. **See how it
was read** opens the finished-read view in the same pane, with **Back to review**. A replacement
has an accent-soft note: “Approving replaces the N memories from the earlier read of this lane.”
The held-back count remains visible.

- **Needs your call · n** contains only identities with a suggested existing match. Each row
  shows the name, kind and wrapped reason. One candidate gets **Same as … / New**; multiple
  candidates get a native select with short name/kind entries and the selected description
  below. **Accept all** accepts suggestions; **All new** overrides identities to new.
- **N new people and things · no decision needed** is closed initially. New or uncertain
  identities with candidates still offer the same choices inside; those without candidates
  are wrapping chips.
- **Possible groups** keeps yes/no checkboxes and bulk choices.
- **Memories · k of n selected** groups checklist rows by type. Each group has a checked,
  unchecked or mixed checkbox for the entire group, including other pages. Rows show the
  sentence with a non-shrinking outcome tag at its right, reason, existing target, supported links
  and quotes. Groups page at 20.
  Confirmations remain a separate disclosure.
- A sticky action bar stays at the pane bottom even for a short review. It says “Nothing is searchable until you approve it.” with **Reject all**
  and **Approve N** (or **Approve confirmations**). An empty ordinary approval is disabled
  unless groups or confirmations are being saved; replacement reviews can approve zero.

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

The **Knowledge** tab keeps search and a browse/detail column beside the graph. On Desktop the
graph is always visible; there is no hide-graph control. The explorer trail survives switching to
**Lanes**. Names, summaries, evidence and controls wrap within their column.

- **Find** (`/`): one box for people, projects and memories (`brain:find`): names, aliases and
  keys, word and trigram matches, then nearest vectors. Arrow keys and Enter; Esc clears the field.
- **Overview**: a neutral kind filter shows All and only populated kinds (People, Teams,
  Organizations, Projects, Systems, Documents, Concepts, Events). **Most connected** pages twenty
  entities at a time (`brain:entities`), ranked by connections. Its memory count includes historical
  memories, as on entity cards. **Recently learned** shows ten current memories from recent finished
  reads (`brain:recent`), with the lane and learned time; a kind filter hides it.
- **Entity**: name, kind tag, description, aliases, source lanes, merged names and memory count.
  **Connections** reads from that entity's side in plain words (Owns / Owned by, Part of / Contains,
  For customer / Customer of), with chips and paging (`brain:connections`). **Memories** has type
  filters with counts and wrapping rows. State, source lane and Include superseded filters remain
  available (`brain:entityMemories`).
- **Memory**: type, state, learned time, summary and every named entity; evidence with matched
  words highlighted and each quote’s stored label, unchanged. Quotes do not carry their own
  session path, so one memory-level **Open in lane** opens the origin lane; no quote is attributed
  to that lane. Supported links, History and Related rows remain available. Dates and scope remain in a disclosure. **See the read that produced this** opens its job
  in Lanes. **Forget** removes the memory as before.
- **Trail**: Back and Forward (`Alt+←` / `Alt+→`, or Backspace outside fields), then plain-text
  Overview and the previous two steps plus the current selection. Older steps collapse to an
  ellipsis. Clearing selection goes to Overview without deleting the forward trail.
- **Graph**: selecting a node, row, chip or result keeps the bounded overview (`brain:overview`)
  drawn. The selected node, its direct neighbours and links stay bright; the rest dims. The camera
  stays unchanged for an in-view selection in **Whole graph** mode, never zooming into the
  selection. If the selection is outside the view or newly added, it fits the whole graph. A
  memory highlights every named entity and the links it supports. Selected things outside the
  overview are included with their neighbours, still capped at 300 nodes: selection first, then
  route nodes, direct neighbours and the rest of the overview.
  A bounded-selection notice remains visible when the graph is truncated.
- **Clear selection**: the selection chip's ✕, empty graph space, Esc outside fields/dialogs/menus,
  or the Overview breadcrumb restores the whole graph and fits the camera. **Whole graph** is the
  default; **Neighbours only** explicitly switches to one or two steps (`brain:neighbourhood`),
  and fits that neighbourhood; clearing resets that choice. Fit fits everything currently shown.
  Zoom and 2D/3D controls remain available. The legend along
  the bottom lists only present kinds, with the filter’s plural words (People, Systems), and
  shares its theme-token colours with the column's kind dots. The keyboard focus badge sits
  inside the canvas, separate from both the legend and selection controls.
  Node labels keep a twelve-CSS-pixel height as the camera zooms and draw over the spheres in
  front of them. On every frame a label that would cover a more important one is hidden: a
  selected or hovered label always shows, then lit nodes, link words and the rest by size.
  Labels take no pointer hits; nodes and links do. Directed links show predicate words on
  selection or hover; hovering a link loads its supporting memory and leaving the link or
  canvas clears it. A hover counts only while a pointer is on the canvas. On an unselected
  graph it lights the hovered node and its neighbours; with a selection it lights only the
  hovered node and never dims the selection. Groups with no link between them stop repelling
  at a fixed range, so they stay in view instead of drifting apart. Reduced motion uses
  instantaneous camera moves.
- **Find route to…**: up to three shortest supported routes between two entities, at most four
  hops, each hop with its memory, highlighted in the graph (`brain:path`).
- **Merge into…**: folds one entity into another after a confirmation. Names, keys, links and
  memories move; the source is deleted and the merge is journaled. The confirmation shows both
  descriptions and memory counts, so identical names remain distinguishable. Its toast and
  Tidy's Recent changes offer Undo; later edits can prevent a clean undo.

Views reload when Brain's revision or generation changes, and a failed load offers Retry.

The two browse reads run in the search worker and keep the browse indexes introduced in **schema v5**:
`brain:entities(kind | null, offset, limit)` accepts limits 1–100, returns entity/count rows,
`more` and populated `kinds`. It walks `entities_connections` in connection-count descending,
row-number ascending order, leaving out memory-less and merged-away rows. Kind filtering may
walk farther; finding populated kinds makes one entity-table pass. `brain:recent(limit)` accepts
1–50, walks at most twenty finished jobs through `jobs_finished`, and reads their active/disputed
memories through `memories_job`, newest read first and recorded time descending within each read.
It stops when full. Memories without a surviving finished job are omitted. `learnedAt` is the
memory's recorded time, not when the source originally said it. These are bounded result sets,
not an assertion that every browse query has constant work at a million memories.

## Inspecting a finished read

A Read row, **See how it was read** in review, or **See the read that produced this** on a
memory opens the read on Lanes, selecting its row when present. An older read outside the
newest 200 stays open without fabricating or selecting a list row. Missing records offer Retry.

The header shows the lane, model name, thinking level, duration and relative finish time.
**Read again** appears for a finished `done` job only. **Result** comes first, showing only
nonzero counts of kept, folded, reconfirmed, enriches, held and dropped candidates. Outcome
rows show the claim, outcome tag and reason; the first 20 have **Show more**. Forgotten
memories say “removed”, not a dead link. **Memories from this lane** opens each memory on
Knowledge. **How it was read · n calls** has one closed disclosure per call, named in plain
words with part number and duration. Opening shows the scrubbed raw output with Copy,
rebuilt prompt and diagnostics, without cost or token counts. Raw output, prompts and source
text each have a capped, internally scrolling box.

**Source lane at extraction** is the scrubbed transcript through the frozen leaf. Records store no
prompt text; a prompt whose inputs are gone says so. Records are kept while their job is in the
inbox or is the latest finished read of its lane, without an age limit. These jobs also keep
step inputs, so finished-read prompts can be rebuilt. Removing or replacing a job deletes its
step inputs. A record without a job survives only while a memory references it, and expires
30 days after it finished; its prompts are unavailable. With neither job nor memory, the record
is pruned immediately.

## Storage

`<userData>/brain/brain.sqlite` (`libs/memory-engine`, schema version 6, WAL) holds settings,
the queue and its saved steps, proposals, extraction records, entities (names, aliases, keys),
memories, mentions, supported relations, citations, evidence, float/sign-bit vectors, Tidy
suggestions, a bounded operation journal, and the saved sweep cursor and run checkpoint.
Full text search covers memories, entity words and entity name trigrams.

Versions 4 and 5 upgrade in place in one transaction. Version 4 first gains the jobs `replaces`
column and lane-memory/finished-read indexes; both versions then gain the Tidy tables and
indexes and become version 6. Knowledge, preferences, jobs and records stay. A failed upgrade
rolls back completely. Version 6 opens without altering its run checkpoint; the runtime owns
interrupted-run recovery. Newer versions are refused. Opening versions 0 to 3 deletes their
knowledge, keeps preferences with review on, and starts a new generation, as **Reset Brain
knowledge** does. The model lives under `<userData>/brain/embeddings`.

### Tidy storage and local sweep

Suggestions have indexed kind, source, state, subject ids, reasons, verdict, reader model and
lane-flag fields. A canonical two-subject pair key does not depend on its suggestion kind;
dismissed and cleared pairs stay suppressed. A flag key combines the memory and lane session;
flag limits are under Tidy checks and lane flags. Missing or superseded memories refuse flags
without changing the revision.
Known states are validated on write; unfamiliar future kinds are omitted from reads.
Suggestion details remain readable after they settle, with only surviving subjects; a removed
suggestion returns null rather than an error. Details include engine-owned `allowed` actions;
apply uses the same guards. Either two-memory suggestion kind supports dispute and replacement.
Folding also requires active memories with no history or dispute. `foldRefusal` distinguishes
applicability from history, and an existing dispute cannot be added twice. Settled or missing
subjects offer no actions.

An approval commits before sweeping its touched records. Entity merges and undo also sweep
changed mention sets. Inside the change, this maintenance sweeps at most 128 touched memories
(lowest row numbers first). The rest lose their fingerprints and wait in memory; after the change
returns, the runtime sweeps them 128 at a time, yielding between batches, refreshing search and
notifying after each, and stopping on dispose or reset. If Phosphor closes first, the missing
fingerprints bring those memories into **Tidy now**: when a whole-Brain pass reaches its last
memory, it reads the memory table in windows of 4,096 rows from a second cursor and sweeps the
active memories that have no fingerprint, 128 per call. The pass is done only when that closing
walk finds none left, so a memory deferred behind the cursor is covered in the same pass. Only a
sweep writes a memory's fingerprint. A sweep failure emits a
warning and does not roll back or report the saved approval/change as failed; running Tidy
again retries local detection. Each whole-Brain
sweep call walks at most 128 entity or memory rows from a saved numeric cursor and fixed pass
watermarks. Coverage reports records visited, totals, limited checks and pass completion, not an
exhaustive comparison of every pair. Name/alias buckets inspect at most 16 candidates, eight
names per entity; a one-word person name also offers full-name token matches. The sweep never
merges entities automatically. Reasons name the matching labels or alias; shared full-name
evidence takes precedence over one-word matches. After a merge, suggestions about the removed
record close, and a bounded sweep reconnects the survivor to remaining matching records and
compares the merged records' memories again.

Near-memory detection uses the four mentioned entities with the fewest memories, plus up to
16 same-kind name-matching siblings for each, through those same bounded name buckets. Each
identity contributes its newest 256 stored memories (numeric insertion order). The sweep scores
those windows by cosine, retains the best 32 candidates across all identities, and offers at
most eight pairs per swept memory at cosine 0.84 or above. Project and branch differences are
shown in the reason, not excluded from comparison. The threshold admits observed 0.86
paraphrases and contradictions while excluding the observed topic-only pairs at 0.80 or below.
Similarity only raises a question, never applies a change. Two memories supporting one link
are not a defect.

A sweep call caches up to 128 entity vector windows in least-recently-used order (about 96 MiB
of vectors); eviction permits a re-read without changing candidates. Folds invalidate the
windows because mentions changed. Limited checks count:

- a memory that mentions more than four people or things;
- more than 16 same-name records offered together as siblings;
- more than eight names on one record;
- more than 256 memories about one person or thing;
- a name shared by more than 16 records.

These are checks cut short, not distinct records or cache evictions. The page shows the count
quietly under coverage and explains that a repeat could be missed there. An older partner beyond
a memory window can be missed. A single memory scores at most 4 × 17 × 256 vectors before the
shared best-32 cut.

Only exact repeats fold automatically: the folded sentence, type, project scope, branch,
validity dates and complete mentioned-entity set must match. Disputed or historical memories
are not automatically folded. Fingerprints are indexed and updated when mentions change;
upgrades create the index empty and the sweep fills it incrementally, not during startup.
Folding preserves the survivor's sentence and unions mentions, citations and supported links;
a copied quote with the same entry id is not independent support. Different scopes, branches
or validity periods cannot be folded.

Every merge, fold, dispute and replacement records a reversible operation. The newest 200
operations retain versioned, validated before-images of changed source rows, with an expected
after-row digest. Unchanged rows an undo depends on are kept as guards: key and digest only,
never a before-image, and never a vector. A fold guards both memories' quotes, mentions, links
and evidence. A merge guards only the memories whose mentions or relations it rewrote: their
rows that name the survivor and their memory links. Float vectors use base64 blobs. Counts, FTS
indexes and sign bits are rebuilt, not journaled. Undo restores only the rows the operation
changed and refuses when later edits prevent a clean restoration; new survivor facts stay.
Added support, mentions or links on a fold's memories refuse its undo rather than lose later
contributions. A merge refuses only when a later write depends on it: a relation or mention
naming the survivor on a memory it rewrote, or a later merge, fold, dispute or replacement on
those records. A later quote, or a mention of someone else, leaves a merge undoable: the
mention goes back to the restored person and the later quote stays. Dispute and
replacement undo preserve independent additions and recompute dispute state from surviving links. Search's normal refresh reloads vectors
restored below its previous watermark. Undo drops its before-images immediately but retains
the operation's one-line record. Undo also remembers the pair as dismissed, including automatic
folds and manual entity merges, so the next sweep does not repeat the undone change.

Forget remains permanent, including knowledge folded into the memory at any depth. Fold
ancestry references survive intervening undo and retention pruning, so Forget redacts all
reachable retained before-images. It deletes suggestions about that memory and preserves only
safe operation ids/labels; an operation whose undo would restore forgotten text becomes unavailable.
Folding scrubs removed subjects' suggestion text (even after undo), while an open lane flag moves
to the survivor if it has no open flag or prior flag from that lane; otherwise it closes. The fold's journal records the move, so undoing the fold puts the flag back on the memory the lane flagged, and Forget of that memory erases its flags wherever they sit. A merge can still be undone for its other memories. Reset erases
all Tidy state as well as the knowledge. These guarantees do not change existing proposal and
extraction-record retention: source transcripts retained for finished reads can still contain
the original statement until those records are removed under the retention rules above.

- Entities (`BRAIN_ENTITY_KINDS`): person, team, organization, project, component, document,
  concept, event. Shared across projects.
- Links (`BRAIN_PREDICATES`): owns, works_on, member_of, part_of, for_customer, documents,
  depends_on, uses, decided, prefers. A memory states any number of
  links and names any number of entities.
- Types (`BRAIN_MEMORY_TYPES`): decision, open, risk, procedure, preference, fact, each recording
  how it is known (observed, reported, inferred), its project, its branch when it only holds
  there, its lane, and its state (active, superseded, disputed).

Extraction enforces these endpoint kinds (`BRAIN_LINK_RULES`). Review can re-point identities
across kinds, so the engine does not enforce these rules.

| Link         | Subject kinds                                  | Object kinds                                           |
| ------------ | ---------------------------------------------- | ------------------------------------------------------ |
| owns         | person, team, organization                     | project, component, document                           |
| works_on     | person, team                                   | project, component, document                           |
| member_of    | person, team                                   | team, organization                                     |
| part_of      | component, project, document, team             | component, project, team, organization                 |
| for_customer | project, component, document, team             | organization                                           |
| documents    | document                                       | project, component, concept, team, organization, event |
| depends_on   | component, project                             | component, project, organization                       |
| uses         | component, project, team, person, organization | component, project, organization, concept, document    |
| decided      | person, team, organization                     | project, component, document, concept, event           |
| prefers      | person, team, organization                     | component, project, concept, document, organization    |

A link needs its own supporting quote. Co-mention and shared name prefixes do not justify links.

Search runs in its own utility process (`brain-search-worker`) with a read-only connection and
the sign-bit index in memory, so scans and walks never block main or the writer. Nearest
neighbours below 2,000 items are exact; above, a Hamming scan keeps the closest 2% (2,000 to
20,000), an asymmetric score keeps 1,000, and exact cosine picks the result. On real
EmbeddingGemma vectors of 60,000 made-up sentences it returns 99.9% of the exact top 10
(recall@10 0.9992, 400 queries); at a million that is extrapolated, not measured.

## Tidy checks and lane flags

**Tidy now** first runs bounded local sweep chunks, then checks at most forty oldest unjudged
pairs, eight per call. It shares the Brain reader queue with lane reads: neither runs beside
another. The check only proposes; it never applies a model verdict. For two memories,
`different` clears and remembers the pair. The model never takes two people or things off the
owner's list: for an entity pair, `different` records the verdict and its reason, keeps the
sweep's reason, and leaves the suggestion open. The page then says "Checked by <model>, which
thinks these are different. Merge only if you know they are the same." and still offers Merge
and Not the same; only Not the same closes it. A pair with a verdict is not sent to the model
again. `conflict` and `replaces` remain for review, with the proposed newer side when
supported. Uncertain answers are `different`, not permission to merge people by name. A
different project or branch alone never decides a verdict: the model judges whether the
assertion is limited to its project or branch or holds anywhere, so two contradicting standing
preferences of one person in two projects are a `conflict`.

The check uses **Model that reads lanes** when pinned, otherwise the model of the newest
finished read whose launch is available. It tries the newest five finished reads for an account
and launch, even with a pinned model; without one it explains why the check was skipped. The
local pass still runs. It uses the same private, tool-less, session-less one-shot path and
600-second timeout as lane reads, with thinking capped at medium and one transport retry.

Only bounded pair evidence leaves this machine, sent to that reader model's provider: memory
sentence, type, dates, project scope, branch, entity names and up to two quotes of 300 characters;
entity names, aliases, kind, description, memory count and up to five neighbours with link words.
It sends neither the whole Brain nor whole lanes. Text is scrubbed and escaped inside a
`background-data` wrapper with no instruction authority. Model reasons and verdicts are stored
with the exact reader model id, not usage or cost figures. Progress is saved between calls.
Cancel stops further calls; an interrupted run retains progress and offers Retry rather than
silently calling a model on startup. A failed batch leaves its pairs unjudged while later
batches continue. Malformed items and unknown handles are dropped and counted; Retry checks
only pairs still without a verdict.

With recall on, **brain_flag** takes `{ ref, problem, reason }`: a memory's bracket number from
the latest search briefing in that lane, `wrong`, `outdated` or `duplicate`, and 1–300 characters
of evidence. The extension retains only that briefing's displayed number-to-id map per session.
Unknown numbers require another search. The server accepts active or disputed memories, one
open flag per memory, at most five open flags per lane session and at most fifty open flags in
the whole Brain; the same lane cannot flag the same memory twice. The local bridge accepts ten
flag requests a minute from all lanes together, so a lane cannot dodge the limits by claiming
another lane's id. It records the claimed lane id and title; the page trusts only the id, to find
the lane in Phosphor's own list. Reasons are
untrusted, bounded data, never instructions. A flag adds a review suggestion, not a knowledge
change. The skill asks agents to flag only user contradictions, verified wrong or outdated
facts, or duplicate recalled memories—never a guess, an agent preference or mere irrelevance.

## Recall

When Brain and recall are on, lane startup (`SessionStartupRuntime.recall`) adds
`PHOSPHOR_BRAIN_ENDPOINT`, `PHOSPHOR_BRAIN_TOKEN`, `-e brain-ext/brain.mjs` and
`--skill skills/brain`. The endpoint is a local socket; the token is random per app run. Recall
never blocks a lane: any failure starts it without Brain. Search stays read-only; flags only
ask the owner to review. Both tools use the version 5 local bridge.

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

- Extraction quality is the reader model's. Review catches a wrong link or identity; afterwards,
  Forget and Merge into… fix it.
- A merge, fold, dispute or replacement can be undone while its journal is retained and later
  changes permit a clean restoration. Forget is never undone.
- Desktop only, one machine. Nothing syncs between machines or to Hosts.
