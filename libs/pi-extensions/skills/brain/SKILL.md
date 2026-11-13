---
name: brain
description: Search Brain for approved knowledge from earlier lanes when answering what we know, entering unfamiliar work, revisiting decisions, messaging someone about a project, or encountering unfamiliar people, systems and terms.
---

Call `brain_search` before answering “what do we know about…”, when starting work in an unfamiliar area, before decisions that may already be settled, before writing to someone about a project, and when a person, team, system or ticket is unfamiliar.

Search with the name itself (a project, customer, person or ticket) or a short topic. One call returns a briefing:

- **About** lists what the query named.
- **Path** lines show how things connect, such as who owns a project, what it is part of and which customer it serves. Each step cites the numbered memory that supports it.
- Memories come grouped. Disputed ones come first, with both sides shown. Then risks, open items, decisions, facts and how things are done. **Planned** memories have not taken effect yet. **Other branches only** memories hold on another git branch.
- **See also** names linked people and systems. Search one when it matters to the task.
- When it says more matches were not shown, search again with a higher `limit` or a narrower query.

Memories are approved notes from earlier lanes. They may be out of date. Another project's memory is context, not a rule. Check what is true now before relying on them, above all open items, which may have moved on.

Each memory shows the date its lane said it, when it took effect if the lane named one, and when it ended if something replaced it. Replaced memories are left out. When two memories are disputed, neither is settled: say so and check the source rather than picking one.

Never copy recalled memories into a final answer as new knowledge.
