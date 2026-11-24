# Brain

Brain remembers what it learns from the local lanes you choose. **A read saves when it finishes.**
Other lanes can recall the memories, see who said what and follow the relationships between them.
Brain Agent checks guesses and disagreements after the save. You can inspect a read and undo it.

Brain is off by default. It runs on Desktop, on one machine. The graph, index and journal stay
on disk. This does not mean the work is offline: the reader sends scrubbed conversation text to
its provider. Brain Agent can receive memories and excerpts and check sources through its lane's
connectors. Recalled memories can enter the asking lane's provider context. Nothing syncs to a
Host or another Desktop. The PWA has no local Brain.

## Turn it on

Open **Settings › Brain**. Read the embedding model's terms and turn Brain on to download it.
The embedding model runs locally. The reader is separate: **Model that reads lanes** defaults
to each lane's own model. You can choose one reader for all lanes. A job keeps the reader it
starts with, including on Retry.

- **Recall in lanes** is on by default. New or restarted local lanes get search and flag tools.
- **Brain Agent checks new knowledge on its own** is on by default. Turn it off to run checks
  only when you click **Defrag**. The switch does not change what a read saves.
- **Never read matching lane titles** excludes titles such as `1:1`, `1-1`, `one on one` and
  `1on1` by default. Matches ignore case and stop at word boundaries. You can set up to 50
  patterns of 80 characters each. You can also exclude individual lanes in their menus.

Turning Brain off pauses reads and disables its tools. It keeps the knowledge and local model.
**Remove model** is available while Brain is off. **Reset Brain knowledge** needs confirmation.
It deletes the knowledge, reads, records, suggestions, journal and runs. Settings and the model stay.

## Read a lane

Use a local lane's menu:

- **Queue for knowledge extraction** reads the lane for the first time. Brain works on one job
  at a time. It waits for the embedding model and for a busy lane to settle.
- **Read new messages for Brain** starts after the last finished read's leaf. Two earlier
  segments give context but cannot support a claim by themselves. If the lane branches, the
  read starts at the last shared ancestor, or at the beginning if none remains.
- **Read again for Brain…** reads the whole lane. The confirmation tells you how many earlier
  memories it can replace. Those memories stay searchable until the new ones save together in
  one transaction. An empty or failed read does not clear them. See [what carries](#what-carries-to-the-survivor).
- **Never let Brain read this lane** excludes the lane by id. A title rule also excludes it,
  even if you remove that id. Brain checks the current title before it starts. It never reads
  its own lane or lanes inside its folder.

Cancel a queued or running read from the menu. Interrupted reads return to the queue at startup.
Retry resumes the same job from saved steps unless another read of the lane comes after it.

### What the reader saves

The reader freezes the leaf, branch, reader and thinking level at first start. It reads user and
assistant text on that path, not tool output or compaction summaries. It can read an archived
transcript in place of its original. It scrubs secrets and contact details before sending text.
The reader's calls use private, session-less pi processes with no tools or connectors.

1. **Extract claims and links.** The reader looks for a statement that will matter in another
   lane: a decision, open question, risk, procedure, preference or fact. It records who or what
   the claim names and matches each quote against the source. It asks for every lasting
   relationship the claim supports, not every event. Each link needs its own quote and two
   mentioned endpoints of allowed kinds. The parser drops a bad link, not its whole claim.
   Unknown predicates, labels over 80 characters and invalid dates do not pass.
2. **Match identities.** Reuse a known person or thing when the evidence fits. A name alone
   does not prove that two people are one. An uncertain match, even one that needs an answer,
   saves as a separate record. If there is a candidate, Brain Agent gets a suggestion to check
   the two. Another read reuses a pending guess for the same name, kind and best candidate.
   A description fills an empty one, never overwrites one. A possible group goes to Brain Agent,
   not straight onto the map. If the reader identifies you and no owner is set, your record
   becomes the centre of the map.
3. **Compare with existing memories.** New claims can add a memory, confirm it with a quote,
   add supported links, replace it, dispute it or answer an open question. Similarity finds
   candidates; it does not decide truth. A claim also carries importance: low for background,
   normal by default, high for things like a key decision, commitment, owner or risk.
4. **Embed and save.** Brain saves against the knowledge revision used for comparison. If it
   changes, the reader compares again from its saved work and reuses calls with matching
   inputs. After three stale attempts the job fails with a Retry, rather than saving guesses
   against the wrong revision. An index refresh failure does not roll back a saved read.

**Temporary** claims use their stated end or, if none, 14 days from when the claim was observed
or from its stated start, whichever is later. Their links inherit that end unless they have one
of their own; a link that starts later ends 14 days after its own start. Nothing ends before it
starts. A temporary claim cannot supersede, enrich, resolve or put a lasting memory in
dispute. It saves separately instead. **Personal** claims, such as someone's health, pay or
performance, never become memories or confirmations.
They count as left out in the read record. That is not a promise to remove them from the source
transcript or the record of what the reader saw.

A saved read is one change, for example “Read Harbor planning: 9 memories”. An empty read has
no change to undo. So does a read with only group questions when none opens (already asked,
or fewer than two members). Undo removes what the read added and restores what it replaced,
including its links. It refuses if later work depends on the change or a later read of the lane exists.
The job stays in history as not saved (`rejected`, zero memories), with its extraction record.
It does not run again on restart. Use the lane menu to **Read again**.

## Relationships are sentences

“Tom Lee took over Ledger billing from Rina Okafor” links two people. `took_over_from` is the
category; “took over Ledger billing from” is the **label**, read from subject to object. An
empty label uses the category's words. A link can say **since** or **until** a date, or give
both. It says who stated the relationship: the reader, Brain Agent or you. That is separate
from who spoke in the memory's source.

Entities can be people, teams, organizations, projects, components, documents, concepts or
events. `reports_to` joins two people. `works_with` and `took_over_from` also accept teams on
either end. `works_with` goes both ways; a handover has a direction. `works_on` and `decided`
can point to an organization such as a customer account. Other categories include `owns`,
`member_of`, `part_of`, `for_customer`, `documents`, `depends_on`, `uses`, `prefers` and `leads`.
Appearing in the same memory is **not** a stated relationship.

### What carries to the survivor

Nothing automatic deletes a relationship just because a newer sentence omits it. An ended
relationship is history, not a missing edge. Brain tests the end date when it reads the graph;
it does not need to rewrite a row as the date passes.

| Operation                                                       | What happens to the relationship                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add, confirm, enrich or dispute                                 | Existing links stay. New evidence can support the same assertion.                                                                                                                                            |
| Supersede, answer an open question or replace a disputed memory | Carry each link to the surviving memory, including its wording, dates, speaker, mentions and quotes. End a contradicted link rather than delete it.                                                          |
| Correct                                                         | Insert the correction's stated links, explicitly end any named old links, then apply the same carry rule.                                                                                                    |
| Fold repeated memories                                          | Keep the survivor's sentence and unite mentions, quotes and links. Matching triples share their support; missing wording or a missing start can come from the other copy. The surviving end and speaker win. |
| Merge people or things                                          | Point mentions and links to the survivor. Unite duplicate links and their evidence. A link that now points to itself goes away on purpose. An open group question asks about the survivor instead.           |
| Split a record                                                  | Move the endpoints with the memories chosen for the split. Other memories keep their links.                                                                                                                  |
| Read again                                                      | Replace only the lane's own unshared memories and their reader links. A quote or link supported by another lane protects the memory. So does any link stated by Brain Agent or you. The whole memory stays.  |

For a replacement, a different subject with the same predicate and object contradicts the old
link. For example, the newer memory states a different owner of Ledger. For `reports_to`, a new
object for the same subject also contradicts the old link. `works_with` has no direction, so
another pair that shares one end never contradicts it. Brain uses the new memory's start,
or now, to end a contradicted link without an end. Forget and erasure deliberately remove
knowledge. A clean Undo restores the changed rows and their evidence, not just the sentence.

## The Brain page

The map, the selected card and **What changed** share one screen. On a narrow page the card
stacks below the map. The header counts memories, people and things, and items waiting for
Brain Agent. **Search** (`/`) finds a name or memory.
⌘K stays the app's command palette. The status bar shows the current read and queue. A failed
read has **Retry** and **Dismiss**. A Brain Agent run shows its progress, **Stop** and a link to
its lane.

- **Start with you.** The map centres on your record, or a record from the overview if it does
  not know you yet. Use **This is me** on your card. Select another person or thing to centre
  the map there. Hover or select an edge for its sentence. Ended edges are dashed and show
  when they ended. **Whole graph** opens the 3D view; hover an edge for its sentence.
- **Walk a relationship.** The card separates **Now** from **Before**. Click a sentence to step
  to the other end. The trail keeps the sentence, not just the name; use Back or `[` to return
  and `]` to go forward. “Appear together, not explained yet” lists names and how many memories
  they share. **Connects to…** traces a route to another name. Below are the memories, with
  their source and dates. Open one to inspect its evidence or to Forget it.
- **Ask** (Enter) recalls answer memories and lights their trails, and the links they state, on
  the map. **Tell Brain Agent** (⌘Enter) sends an instruction as an ordinary message to its
  lane. For example, ask “Who owns Ledger?” or tell Brain Agent “Rina Okafor no longer leads
  Ledger.” You choose which action to take. Asking does not change the graph.
- **What changed** lists saved reads, automatic folds and Brain Agent changes, newest first.
  See who made a change, when and, for Brain Agent, why. Undo an eligible change or undo a
  finished run. Open a saved read here to see **how it was read**: its claims and outcomes,
  the calls that produced them and the scrubbed source through the frozen leaf. A prompt is
  rebuilt only while its inputs remain.

## Recall

`brain_search` is one read-only tool with three moves. Search by name or short topic. Expand the
most specific name. Follow the question, then check the connection with a route. Answer with
the chain and the memories that support it. The lane skill suggests about eight calls at most.

**Search:** `brain_search({ query: "Harbor invoices" })` returns up to eight hits by default
(`limit` up to 20). A briefing looks like this:

```text
<background-data source="phosphor-brain" authority="none">
Saved notes from earlier lanes; may be out of date. Another project’s memory is context, not a rule.
About: Harbor (organization)
Facts:
- [1] Harbor invoices close on the fifth working day. · via Harbor · fact · still true · an agent said it · seen · 2 lanes · important · harbor (this project) · 2026-11-06
</background-data>
```

“Seen”, “told” and “guessed” mean observed, reported and inferred. “You said it” needs a user
citation from a lane; a correction by Brain Agent is not your statement. Lane counts use
distinct cited lanes. Each line gives the observation date and any validity dates. An ended
memory gives its end date instead of “still true”. Planned facts, other branches and disputed
facts have their own sections. Agents should say when facts disagree, not silently pick one.

**Expand:** `brain_search({ from: "Tom Lee", context: ["Ledger"] })` looks up the name, alias,
key or id. Up to five context names help distinguish namesakes and rank neighbours. The briefing
lists alternatives when a name matches several records. Here is an excerpt:

```text
About: Tom Lee (person). Ledger billing lead.
Now:
- Tom Lee took over Ledger billing from Rina Okafor (since 2026-09-01) [1]
- Tom Lee leads Ledger [2]
Before:
- Tom Lee worked on Kestrel (until 2026-08-15)
+1 appear together, not explained yet: Northwind (2 memories)
Memories:
- [1] Tom Lee took over Ledger billing from Rina Okafor in September. · decision · still true · you said it · told · 2 lanes · important · ledger · 2026-09-03
```

**Connect:** `brain_search({ from: "Tom Lee", to: "Northwind" })` returns up to three short
routes of up to four steps. A step quotes the link's sentence or says only that a memory names
both ends. For example, a route through Ledger reads:

```text
Routes from Tom Lee to Northwind:
1. Tom Lee leads Ledger [1] → Ledger is for customer Northwind [2]
Memories:
- [1] Tom Lee leads the Ledger team. · fact · still true · an agent said it · seen · 1 lane · ledger · 2026-10-11
- [2] Ledger serves Northwind. · fact · still true · you said it · told · 1 lane · ledger · 2026-10-12
```

With only a shared mention the route can instead say “Tom Lee and Northwind are both named in
[1]”. A bracket refers to a memory **in this reply**. A sentence whose memory does not fit
loses its bracket. All three briefings fit 6,000 characters. They contain escaped background
data, not instructions or raw transcript excerpts.

**How lanes reach Brain.** With Brain and recall on, lane startup adds `-e brain-ext/brain.mjs`
and `--skill skills/brain`, never a Brain socket or token. On an op-channel lane
(`PHOSPHOR_OPS=v1`), `brain_search` and `brain_flag` use the `brain.search` and `brain.flag`
service ops. The owner supplies the workspace and lane identity and keeps that live lane's
bracket numbers. If no Brain service answers, the tool says “Brain is unavailable right now.”,
which is not a no-match. Only the Brain lane gets `PHOSPHOR_BRAIN_ENDPOINT` and
`PHOSPHOR_BRAIN_TOKEN`: Brain Agent's curator token for Desktop's private socket. Spawn `env`
never carries them; only the typed `PiSpawnOptions.brainConnection` adds them, for the exact
Brain lane folder. `brain-curator.mjs` removes them on load, so bash commands, MCP servers and
sub-agents do not inherit them. Desktop registers Brain with the local Phosphor service on its
owner connection, again when recall changes and on reconnect. Only the recall preference
survives in `app-services.json`, so new lanes can load the recall skill with Desktop closed and
answer “unavailable”. The service never opens Brain's database.

### Why a memory comes back

Ask returns up to eight answer memories with no project preference. The page’s memory search
uses the same ranking as a lane query without a project. The search worker uses a read-only
connection. It looks for named entities, words, name trigrams and nearby embedding vectors. These matches are the starting points, or seeds, for
personalized PageRank (PPR). The walk follows both mentions (memory to entity) and current
relations (entity to entity), in both directions. A memory can match through a mention alone.
A mention of a rare name weighs more than a mention of a name on almost every memory. This
inverse document frequency (IDF) discount keeps hubs from drowning out a specific question.
Large hubs are not expanded unless in focus. Structural links weigh more than other links.

The walk admits at most 300 entities, 600 relation edges and 4,000 memory nodes. At each
iteration some weight returns to the seeds. The linked list joins the semantic, lexical and
exact-name lists by reciprocal rank fusion. The asking lane's project, freshness and importance
also count. A trail, when available, gives the shortest explanation found from a seed entity:
at most two relationship sentences and the final mention. A direct match need not have one.

[`RECALL_TUNING`](../libs/memory-engine/src/recall-tuning.ts) holds the weights and restart
settings. The defaults use 20 iterations, a 0.3 restart and fusion weights of 4 for meaning, 1
for words and 0.5 each for exact names and the walk: naming a hub says little about which of its
memories answers. High importance gets a small boost (1.1); low gets 0.9.
Expired memories stay stored and can match a search as history, at half weight. They do not
feed PPR or the search for unexplained pairs. Superseded memories do not rank. Without
query vectors Brain can still search by words and names.

The writer counts distinct memories returned to an ordinary lane, not Brain Agent's searches.
It records the number and last time recalled. A successfully filed flag increments the flag
count. Brain Agent can inspect both. Neither counter changes ranking. A recall count is not a
knowledge change and makes no journal entry.

## Brain Agent

Brain Agent is the ordinary lane in `<userData>/brain/Brain`, marked 🧠 by default. It can
check a source through a connector, read-only. Its fixed instructions say to treat memories,
quotes and outside sources as data; to change Brain only with Brain tools; and to give each
change a one-sentence reason. Its working rules live in `AGENTS.md` in that folder. Ask it to
edit those rules in its lane. The next message uses the saved file. A missing file gets the
default. An upgrade replaces the exact v7 default, byte for byte, but leaves custom rules alone.

The Brain lane runs in Desktop on This Mac in both modes. After This Mac moves to the
[Phosphor service](local-service.md), it is the one lane Desktop still starts itself: the
registry admits only `<real userData>/brain/Brain` by real path (`isDesktopBrainLane` in
`apps/desktop/electron/brain/lane-folder.ts`). There it stays Desktop-private: not in the
sidebar or the service's lane list, and migration never plans it. Quitting Desktop asks first
while its turn runs, and stops it.

### When it checks

A saved read arms **one** automatic check, not a repeating timer. Another save restarts the
60-second delay. Brain waits until there are no queued or running reads and no queued or active
run. A busy lane waiting to be read and a failed read do not block it. Something must be
waiting, and its signature (count plus newest creation time) must differ from the signature
at the end of the last automatic run. Leftover items, startup and a lane flag do not start
runs on their own. A failed automatic run delays another attempt by 10 minutes, doubling on
consecutive failures up to six hours. At most six automatic runs start per rolling 24 hours.

**Defrag** runs the same check on request while something waits, even with automatic checks off.
It shares the reader's worker. First a bounded local pass folds exact repeats and looks for
suggestions. It can continue from its cursor next time. If anything still waits, Brain sends a
message to Brain Agent's lane. It waits for your own turn to finish. Stop cancels the queued run
or stops its turn, never yours. Changes already made stay. **Undo run** reverses the run's own
changes, newest first. It skips erasures and dependent changes. Local automatic folds have
their own Undo.

### What it checks and changes

1. **People and things.** Check identity guesses against evidence such as a shared role or
   identifier. Merge only when supported, otherwise keep the records apart.
2. **Groups.** Check whether the members belong to a common parent. If so, reuse or create
   the parent and state `part_of` links. Otherwise dismiss the suggestion.
3. **Unlinked pairs.** Look among the newest 2,000 current, unexpired memories for two names
   that appear together at least twice. Skip hubs and pairs already explained, even by an ended
   relationship. Rank by shared count and specificity. Up to 40 pairs wait at once. When a
   read's new memories are swept, Brain looks only at the pairs those memories name. The end of
   a full pass looks at every pair. A waiting pair that a link later explains is cleared and
   frees its place. Brain Agent reads the shared memories; if no lasting relationship is
   stated it can dismiss the pair. Brain remembers that answer.
4. **Repeats and disagreements.** Fold supported repeats. Keep a disagreement as disputed
   unless there is evidence for a replacement. Similar wording alone is not enough.
5. **Flags**, then possible repeats. `brain_flag({ ref, problem, reason })` files a question,
   not a correction. Use the bracket number from the latest briefing in that lane. `problem`
   is `wrong`, `outdated` or `duplicate`. Give evidence, not a guess. Brain Agent checks the
   source and can keep, correct, fold or erase. Possible repeats do not count towards the
   waiting total and cannot start a run on their own.

`brain_relate` states a relationship with a reason, label, optional dates and one to eight
current memories as evidence. At least one memory must name both ends. The newest such memory
holds the link, marked as stated by Brain Agent. It refuses an existing current link of the
same kind in the same direction. The limit is 60 new links per run, or 20 per rolling hour
outside a run. `brain_edit` can change a relationship's wording or dates and a memory's
importance, as well as merge, split, describe or remove an alias. `brain_correct` supersedes a
memory with a sourced sentence and quote, keeping its importance and its start and end. Its optional `links` state new relationships;
`ends` names old link ids to end. The result says what carried and what ended. These changes
have Undo. See [the tool list](extensions.md#brains-bundles).

## Storage

`<userData>/brain/brain.sqlite` uses SQLite WAL, schema version **8**. It holds preferences,
read jobs and checkpoints, extraction records, entities and names, memories and mentions,
relationships and their evidence, search indexes and vectors, suggestions, the journal and
Brain Agent runs. `memory_use` holds recall and flag counts. The embedding model lives under
`<userData>/brain/embeddings`.

Versions 4 through 7 upgrade in place in one transaction. Failure rolls back. Existing links
get an empty label, unknown dates and reader attribution. Existing memories get normal
importance. The migration does not reconstruct links already lost. Reads waiting for a v7
decision or refreshing one return to the queue with their proposals and checkpoints intact. When processing
resumes, an eligible read saves directly if its revision still matches. Otherwise Brain
compares again from saved parts. An excluded lane is skipped; if the source for a stale read
is gone, the job fails and can be dismissed. The old save preference is discarded; automatic
checks default on. Versions 0 through 3 start a new knowledge store. A newer schema is refused,
not reset. **An older app cannot open a v8 Brain.**

Undo compares the affected rows with what the operation left, including guards for dependent
rows. It restores the before-images only if that can be done cleanly. For a v7 journal row,
v8 fills in missing columns with their defaults and leaves default-valued additions out of the
comparison hash. Earlier merges, folds, disputes, replacements, splits, name and description
edits, keeps and corrections still undo under their original guards. Later edits to a link's
label or dates can prevent Undo. Undoing an accepted v7 read leaves the job not saved, with no
pending proposal. A rejected v7 read cannot be brought back; use Read again. Erasure is final
in either version.

## Limits

- Only the queued lane path and supported quotes are evidence. Reads have a ceiling of 25
  claims per part and 300 per job. The reader can miss a connection or make a wrong guess.
  Neither a short trail nor a high ranking proves a claim. Routes are bounded and skip hubs as
  intermediate steps; no route found does not prove two people have nothing in common.
- Ordinary lanes can search and flag, not edit. Only one flag can be open per memory, five
  per lane session and fifty across Brain. The same lane cannot flag the same memory twice.
  Brain limits all lanes together to ten flag requests per minute.
- The journal keeps the newest 200 changes, changes in the latest run and erasures younger than
  an hour. Brain keeps the newest 20 runs and every automatic run the daily limit still counts.
  A change outside retention or one that later changes depend on cannot be undone. Undoing a
  keep reopens the question. Undoing a fold or merge remembers the pair so the next sweep does
  not just repeat it.
- Forget and `brain_erase` are permanent. Brain Agent can erase at most 25 memories in a
  rolling hour. The journal cannot restore forgotten text. Read again is not a Forget: it keeps
  earlier undo records, so an earlier change that touched a replaced memory undoes completely
  once the Read again is undone, and is refused while it stands. Erasing a memory does not edit the
  original lane or the scrubbed source in a retained read record. Each lane normally keeps
  its newest 20 finished reads. A record without its job survives only while referenced by a
  memory and for at most 30 days after the read finishes.
