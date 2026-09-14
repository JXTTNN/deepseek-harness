---
name: subagent-partitioning
description: Decide when and how to delegate — bounded fresh-context tasks vs. conversation-context tasks (subagent vs subagent_fork), parallel fan-out, and result-merge discipline. Use before any multi-part task, research fan-out, or whenever you are tempted to spawn agents for everything.
---

# Subagent Partitioning

Delegate to shrink your context or to run work in parallel — never to avoid thinking. A bad partition costs more coordination than the work it saves.

## Choose the right delegation

- **`subagent`** — bounded, self-contained tasks with a fresh context: research one angle, audit one category, implement one component against a written contract. The prompt must stand alone; the child does NOT see this conversation.
- **`subagent_fork`** — work that builds on what this conversation already established (review the diff we just wrote, continue the analysis above) without spending your context on the execution.
- **Do it yourself** — anything finishable in a few tool calls. Delegating a single `grep` or one file read is pure overhead.

## Fan-out rules

1. Start independent delegations in ONE message so they run concurrently; never serialize tasks with no data dependency.
2. Give each worker a disjoint slice: one research angle, one file set, one checklist category. Overlapping scopes double the work and fork the answers.
3. In team composition, address teammates with `team_send` and collect with `team_inbox`/`team_list` instead of polling `job_output` in a loop.
4. Keep your own hands busy: while children run, do the slice you reserved or prepare the merge.

## Merge discipline

- Treat every returned claim as unverified until it cites evidence — a `file:line`, a URL, or command output. Spot-check the load-bearing claims yourself.
- Dedupe before synthesizing: two workers finding the same fact is confirmation; two different versions of it is a conflict to resolve explicitly.
- Merge code results sequentially, one editor at a time per file.

## Anti-patterns

- **Parallel write conflicts**: two agents editing the same file concurrently. Partition by file, not by task names that happen to touch the same file.
- **Telephone chains**: passing one agent's summary into a third agent as ground truth.
- **Fire-and-forget**: spawning a worker whose result you never collect or reconcile with the others.
- **Delegation as delay**: using a subagent for a lookup you could finish in one tool call.
