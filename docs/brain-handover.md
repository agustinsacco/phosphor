# Brain handover

This Mac's Desktop Brain moves **once** to This Mac's [local Phosphor service](local-service.md),
when the service can run it. After that the service owns the Brain, and Desktop never serves
its copy from before the move again. Nothing moves to another machine. Nothing is merged with a
Brain the service already has, and the move never overwrites one. Until a move commits, Desktop
keeps its own Brain, so an older or unready service leaves Brain exactly as it was.

The code lives in `apps/desktop/electron/local-machine/brain-handover/` (Desktop),
`apps/desktop/electron/brain/owner-gate.ts` (Desktop's writer fence),
`apps/host/src/brain-handover/` (the service) and `libs/memory-engine/src/handover*.ts` (copy,
upgrade, comparison and tombstone). The owner calls are listed in
[remote-protocol.md](remote-protocol.md#owner-calls).

## When it runs

Desktop first waits for the lane runtime decision. Its Brain accessor and app-service bridge
stay closed during that wait, even if the local owner connection is ready. Brain ownership
does not follow the lane runtime or the service's advertised Brain capability.

- In daemon mode, with a migration permit, Desktop settles any unfinished move, then starts
  one if the service can take the legacy Brain.
- In daemon mode with a migration permit, an attested, qualified local service with an empty
  target can be chosen as the first owner if Desktop has neither Brain files nor Brain Agent
  transcripts. Desktop pins the service installation and durably records its intent, then
  installs a downgrade tombstone at the legacy path without replacing any file. Only then
  does it publish the service's grant. No real Brain store or worker starts until enable.
- A deferred move or an unqualified service leaves a proven Desktop Brain on Desktop, including
  when the service runs the lanes. Its existing owner-only recall bridge still serves local lanes,
  not remote clients. A standalone Host does not need a Desktop decision.
- An unanswered first decision, an occupied target with no matching ownership proof, or an
  unfinished move without a service channel leaves Brain unavailable. A durable service choice
  survives a restart or outage: Desktop never falls back to its own copy.

Desktop starts a move only when all of these hold:

- it has a v7 or v8 `brain.sqlite`;
- every pinned embedding model file is on this Mac at its pinned size;
- the service's `status` says `handover: true`, reader `qualified` and target `empty`.

Otherwise the move is **deferred**: no legacy data or service Brain store is changed.

The service sets `handover: true` only when it has every production port
(`createBrainHandoverNativePorts`):

- the reader preflight;
- the pinned model;
- the model probe;
- the Brain Agent transcript import, through the reserved lane's binding.

A service without them answers `handover: false`, and the move is deferred.

## Readiness

There are two checks.

**Preflight**, at `begin` and again just before publishing:

- the bundle's Brain runtime is qualified for this platform, CPU and pinned Node
  (`resolvePackagedBrainRuntime`);
- pi is an absolute, runnable file.

Preflight reads no credentials, model files or network and makes no provider call. A fresh
service passes it; it needs no Brain of its own.

**Final**, inside `verify` and before Desktop gives anything up:

- The packaged embedding worker loads the sealed model copy, through the same controller a
  running Brain uses, after every pinned hash matches.
- It embeds invented text and must return normalised vectors that tell a query from a document.
- Missing or mismatched files fail before any worker starts.
- The probe's `fetch` always refuses, so nothing downloads and no model terms are accepted for
  the owner.

If the model did not arrive or does not run, `verify` refuses. Desktop then aborts and keeps
its Brain.

## The steps

Desktop records each phase in `<userData>/brain-handover/state.json` before the step it guards.
Each record is written to a temporary file, fsynced, renamed, and the folder fsynced.

1. **Fenced.** `brainService()` refuses to open, the private Brain lane is not admitted, and
   service registration stops. The service claims its empty `<state>/brain` (`active.json`)
   and creates `<state>/brain-handover/<id>/stage/` (0700).
2. **Stage.** Desktop settles the WAL and takes an online backup into the stage. It proves the
   copy has the same content as its source. It copies:
   - `AGENTS.md`;
   - every transcript in the Brain lane's pi folder;
   - the pinned model files.

   It names `activeTranscript`: the transcript Desktop's lane would resume next (its newest,
   the rule Desktop's Brain lane uses). History with no active transcript is refused. Desktop
   never copies credentials, sockets or process handles.

3. **Verify.** The service copies each named file into `sealed/`. Each must be a regular,
   singly linked file owned by the user, reached through no link, at its declared size and
   SHA-256. Pinned model files must also match the release manifest. On the sealed database
   the service:
   - checks the schema and generation `begin` announced;
   - runs `integrity_check` and `foreign_key_check` before and after the engine's own v7 → v8
     upgrade;
   - compares every stored table on the columns both versions share. It accepts only the
     upgrade's own changes: added columns at their default, new tables as a fresh Brain seeds
     them, reads waiting for review back in the queue, and preferences rewritten;
   - opens a throwaway copy that draws the map, recalls, walks a graph and undoes a pre-move
     change.

   Lane sources are counted as still on the service or kept as history; a missing source is
   not an error. Every transcript must have a pi session header. Then the model probe runs.

4. **Tombstoned.** Desktop gives the original file a second name,
   `<userData>/brain-handover/<id>/original/brain.sqlite`, which is never opened. A single
   rename then puts a tombstone at `<userData>/brain/brain.sqlite`: a WAL-mode SQLite file
   whose `user_version` is 1,000,000. Every Brain engine refuses a newer schema rather than
   resetting it (`newer-schema.characterization.test.ts`), so no Desktop build, older or
   newer, can write the legacy path.
5. **Commit.** The service rechecks the reader and rehashes the sealed Brain. It writes its
   ownership marker (`handover.json`) into the sealed folder and renames that folder to
   `<state>/brain`. The rename refuses a target that holds anything. The service then imports
   Brain Agent's conversation, records `committed` and releases its claim. Only then does it
   delete the move's private `stage/`, what is left of `sealed/` (the transcript copies) and
   `scratch/`; the record stays. Desktop records `committed`.

## Brain Agent's conversation

The service imports every sealed transcript into the reserved Brain lane's pi folder,
`sessionDirForCwd(<state>/brain/Brain)`, under the transcript's own name:

- History is imported byte for byte.
- The active transcript changes only its header's `cwd`, to the service's lane folder, because
  pi resumes in the header's cwd, as on a lane move. Its id and every later byte are unchanged.

The import never overwrites a file and never follows a link. It refuses a file under the same
name with different bytes. Each sealed copy must still match its verified digest and header id.

The import then asks the lane owner's binding to bind the active transcript, and the reserved
lane resumes it by path. Running the import again changes nothing. If the binding already
names another conversation, the import refuses. A move with no history binds nothing. The
conversation is never chosen by name, by modification time or from `agent_runs`.

## Who may write

| Desktop record     | Desktop (`desktopBrainOwner`) | Service (`hostBrainAdmission`)              |
| ------------------ | ----------------------------- | ------------------------------------------- |
| none, or `aborted` | `desktop`                     | `open`                                      |
| `fenced`           | `moving`                      | `handover` (claimed)                        |
| `tombstoned`       | `moving`                      | `handover` until committed                  |
| `committed`        | `host`                        | `imported`                                  |
| unreadable         | `moving`                      | `blocked` if its own records are unreadable |

The table describes the move fence. **Local first ownership** also requires the durable
`<state>/brain-owner.json` grant, published atomically without replacing a competing grant.
`open` admits the native runtime of a local service only if that grant names the service;
`imported` admits a verified move instead. A Desktop grant therefore does not prevent a later
verified move. The bridge's former `known` recall sidecar is not an ownership record. Both
runtime accessors check the fences even for cached services.

On Desktop, an unreadable move record or a tombstone alone reads as `moving`. The launch
selector can finish an interrupted first-owner choice only with its matching intent. A
published Host grant and a Desktop tombstone retain Host ownership even when the service
is offline.

On the service:

- an unreadable claim, record or marker is `blocked`;
- so is a marker without its record, or a committed record with nothing published;
- a published Brain is not the runtime's until it is `committed`, so no Defrag turn can start
  before its conversation is bound.

The native runtime's writer guard (`brainOwnership` in `apps/host/src/brain/run.ts`) reads the
admission on every entry point, without a cache. It admits `imported`, and `open` only when the
service is standalone or, for a local service, the `<state>/brain-owner.json` grant names it.
`handover`, `blocked` and an unreadable admission never write.

The guard fences moves, not processes. Host processes with different configs can share one state
folder, so the runtime also takes `<state>/brain-writer.lock` (`apps/host/src/brain/writer-lock.ts`)
before it opens, recovers or creates the store, and reads the admission again once it holds it:

- a second Host process, or a second Brain in the same process, is refused while the holder is
  live, and its status reports `refused` instead of opening or creating anything;
- the lock records the holder's pid and process start time, so a killed holder's lock is reclaimed
  by the next writer, and a reused pid never keeps it;
- the holder releases it on shutdown or when its open fails;
- it sits beside `<state>/brain`, never inside, so a move still finds its target empty.

## Recovery

**First owner, before any Brain exists.** Desktop writes `<userData>/brain-handover/first-owner.json`
with the attested Host's machine identity, canonical installed state directory and a unique fence ID.
The downgrade tombstone carries that same ID. If launch stops before publishing the Host grant,
Desktop retries only in daemon mode with a current migration permit, against that same attested
installation. It pins the installation again and rechecks the service's qualification, empty
unclaimed target and unset grant, and the absence of legacy transcripts. If the Desktop Brain
folder is still empty it installs the intended fence; otherwise the exact matching tombstone
must be the only entry. Desktop keeps Brain unavailable if any check fails. It does not guess
from an old tombstone without an intent, replace a competing grant, or fall back to Desktop.

**Existing Brain move.** Desktop resumes by migration id and asks the service for that move's state:

- **Published or committed, and Desktop recorded `tombstoned`:** Desktop commits again
  (idempotent) and records `committed`.
- **Verified, Desktop recorded `tombstoned`, and the tombstone is in place:** Desktop commits.
- **The tombstone never landed:** an older build may have written the original since it was
  verified, so the move aborts.
- **Anything else before publication:** the service abandons its stage and sealed copies and
  releases the target. Desktop renames the untouched original back over the tombstone and
  records `aborted`.
- **The service refuses to publish** (its target filled, or its reader went away): the same
  abort.
- **The commit answer is lost, or the service is unreachable:** the move stays pending and
  Brain stays fenced until the service answers.

After publication, `abort` is refused. Repair or restore happens on the service, never by
serving Desktop's pre-move copy.

The service rolls a move forward from its marker if it crashed between the rename and its
record. It never infers ownership from an empty folder.

**Service restart** (`apps/host/src/brain-handover/recover.ts`, before the owner socket gets the
handover ports, so Desktop's `commit` never races it):

- **Published, not committed:** the service finishes the commit itself (binds Brain Agent's
  conversation, records `committed`, drops the private copies) with no Desktop call. Desktop
  commits only after its tombstone is in place, so a published Brain is already the service's.
  It does so only when the marker, the move's durable record and its seal agree: the record is
  `verified` or `published` with the marker's source generation, no other move holds the claim,
  every published Brain file still has its sealed SHA-256 and every sealed transcript is still a
  regular file. Otherwise, or without the reserved lane's importer, the move stays fenced
  (`handover`) and the log names why. A failed binding leaves it `published` for Desktop's next
  `commit` or the next restart.
- **Verified, never published:** nothing changes. Only Desktop's `commit` publishes.
- **Committed or aborted:** leftover `stage/`, `sealed/` and `scratch/` are deleted; the record
  and anything else in the move folder stay. A move that has not settled, or whose record is
  unreadable, keeps everything.

**Interrupted `begin`:** a crash after the claim and before the record leaves a claim with no
record, which fences the target. `abort` with that exact migration id deletes the move's folder
and releases the claim (it answers `none`). Another id, or a marker that names the id, leaves the
claim in place.

**Downgrades.** An older Desktop that predates the move sees the tombstone and refuses Brain,
leaving the file as it is. A fresh service choice installs the same downgrade fence without replacing a legacy file.
A service that predates native Brain can still use the attested legacy bridge while Desktop owns
the Brain.

## Limits

- The positive model probe has run only with synthetic stand-ins. Release qualification needs
  the signed bundle and the real model on each advertised target.
- A move blocks launch with no progress screen. After a `verify` call times out, Desktop keeps
  checking for up to about ten minutes. A move refused at `verify` is tried again at the next
  launch, copying again.
- The original under `brain-handover/<id>/original/` is kept and never cleaned up. The
  service's cleanup only touches its own `<state>/brain-handover/<id>/` folders.
- A restart that rolls a move forward hashes every published Brain file, the model included,
  once, before the owner socket answers handover calls.
- A process running as the same user could replace a staged file between the check and the
  open. The pinned hashes limit what it can introduce.
