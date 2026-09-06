# Multi-Agent Collaboration Research ！ Recommendations for DeepSeek Harness packages/team

## 1. Framework comparison (coordination, strengths, failure modes)

### AutoGen (Microsoft)
- GitHub: https://github.com/microsoft/autogen ; paper: https://arxiv.org/abs/2308.08155
- Coordination: conversation-centric. SelectorGroupChat = broadcast pool, LLM picks next speaker per turn; RoundRobin; Swarm = agents hand off control via tool calls; Magentic-One = orchestrator with task+progress ledgers dispatching specialists; GraphFlow for DAG workflows.
- Strengths: flexible patterns, explicit termination conditions, strong human-in-the-loop.
- Failure modes: speaker-selection loops / conversational drift, broadcast chatter burns tokens, no shared-file conflict handling, premature termination.

### CrewAI
- GitHub: https://github.com/crewAIInc/crewAI ; docs: https://docs.crewai.com/concepts/crews
- Coordination: role-based crews; processes: sequential, hierarchical (manager delegates+validates), consensual (planned). Tasks emit typed outputs consumed downstream ！ implicit pipeline, not a blackboard.
- Strengths: simple mental model; manager+delegation maps to our parent/subagent; good for assembly-line deliverables.
- Failure modes: manager bottleneck, hallucinated delegation, error propagation down sequential pipelines, weak peer iteration, verbose role prompts.

### LangGraph multi-agent
- GitHub: https://github.com/langchain-ai/langgraph ; docs: https://docs.langchain.com/oss/python/langgraph/multi-agent
- Coordination: graph nodes over a shared typed state. Patterns: supervisor (central router, workers return to it), network (any-to-any handoffs), hierarchical subgraphs. State = blackboard; edges = control flow.
- Strengths: explicit inspectable control flow, durable checkpoints.
- Failure modes: graph design burden, unbounded state growth, supervisor-only topologies force extra round-trips for peer consultation.

### OpenAI Swarm / Agents SDK
- GitHub: https://github.com/openai/swarm ; https://github.com/openai/openai-agents-python ; docs: https://openai.github.io/openai-agents-python/multi_agent/
- Coordination: two patterns only ！ handoffs (transfer whole conversation to another agent) and agents-as-tools (orchestrator calls specialists as functions, keeps control). Guardrails + shared context object.
- Strengths: minimal, production-oriented; handoff model eliminates the "who speaks next" problem.
- Failure modes: handoffs lose control unless agent hands back; agents-as-tools = fan-out with no peer dialogue; little shared memory.

### MetaGPT
- GitHub: https://github.com/FoundationAgents/MetaGPT ; paper: https://arxiv.org/abs/2308.00352
- Coordination: blackboard-ish shared message pool with publish/subscribe by role+topic; roles follow SOPs and pass structured artifacts (PRD, design docs) instead of raw chat.
- Strengths: structured artifacts reduce cascading hallucination of free-form chat (core claim of the paper); predictable decomposition for software tasks.
- Failure modes: rigid SOPs fit exploratory work poorly; subscription misfires; early design errors propagate downstream.

### ChatDev
- GitHub: https://github.com/OpenBMB/ChatDev ; paper: https://arxiv.org/abs/2307.07924
- Coordination: waterfall phases (design/coding/testing/docs); each phase is a 2-agent "chat chain" (instructor/assistant) with a turn cap.
- Strengths: cheap deterministic turn-taking; role-pair compression keeps contexts small.
- Failure modes: no real iteration (waterfall); fixed role pairs hit impasses with no escalation path.

### Claude Code subagents
- Docs: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Coordination: main agent spawns fresh-context subagents (own system prompt, tool whitelist); one report returned. No peer messaging; the filesystem is the only shared channel.
- Strengths: context isolation (research/explore without polluting the main context); cheap parallel exploration.
- Failure modes: subagents cannot ask clarifying questions mid-run; duplicated work across siblings; merge conflicts handled by convention only.

### Roo-Code orchestrator mode
- GitHub: https://github.com/RooCodeInc/Roo-Code
- Coordination: Orchestrator mode decomposes the task into subtasks executed by specialized modes; results bubble back up. Modes = capability profiles (e.g. read-only architect).
- Strengths: per-mode tool/capability restriction prevents accidental edits; explicit subtask contracts.
- Failure modes: orchestrator must anticipate decomposability; stalls when a subtask needs sibling input.

### Also relevant: AgentScope, opencode, Gemini CLI
- AgentScope (https://github.com/agentscope-ai/agentscope) ！ actor-model message passing with explicit msg-hub; strong on fault-tolerant distributed agents, heavy for local teams.
- opencode (https://github.com/sst/opencode) and Gemini CLI (https://github.com/google-gemini/gemini-cli): primarily single-agent terminals; community subagent support mirrors the Claude Code fresh-context pattern ！ no peer messaging.
Cross-cutting takeaway: three viable primitives recur ！ (1) orchestrator fan-out/fan-in, (2) shared blackboard/state with pub-sub, (3) artifact handoff via SOP pipeline. Nearly every documented failure mode traces to free-form peer broadcast chat.

## 2. Evidence from papers
- Multi-agent Debate (https://arxiv.org/abs/2305.14325) and CAMEL/Society-of-Mind work (https://arxiv.org/abs/2303.17760): a few agents debating/verifying measurably beat single agents on factuality and math ！ but gains saturate at ~3 agents and debate converges toward the first confident answer (conformity/sycophancy).
- More Agents Is All You Need (https://arxiv.org/abs/2402.05120): sampling N INDEPENDENT answers + vote scales robustly with N ！ importantly, no discussion between agents; independence is what helps.
- Why Do Multi-Agent LLM Systems Fail? / MAST (https://arxiv.org/abs/2503.13657): 150+ annotated traces, 14 failure modes in 3 categories: (i) poor spec/decomposition and role disobedience, (ii) inter-agent misalignment (lost context, redundant questions, premature termination), (iii) missing/weak end verification. Gains from naive multi-agent on popular benchmarks are often minimal.
- Software tasks: MAGIS (https://arxiv.org/abs/2403.17927) ！ role-specialized teams (manager/developer/QA) beat single agents on SWE-bench-style GitHub issue resolution; OpenHands (https://arxiv.org/abs/2407.16741) shows a single strong agent with good tools is a hard baseline: multi-agent wins only when decomposition is real, verification is strong, and contexts stay clean.


## 3. Design recommendations for DSH packages/team
(Our primitives: shared filesystem workspace; durable session stores; JSON team_send between sibling sessions; parent orchestrator spawning fresh-context subagents.)

### 3.1 Subagent vs sibling team session ！ decision rule
Use a SUBAGENT (fresh child) when ALL of: (a) bounded task returning one deliverable; (b) no mid-run input needed from siblings; (c) you want its context discarded (exploration, research, self-contained implementation, independent re-derivation for voting). Children are one-shot: seed it, collect one report.
Use a SIBLING TEAM SESSION (team_send) when ANY of: (a) back-and-forth negotiation is needed (interface contracts, does-your-module-need-X); (b) a long-lived role must accumulate state across assignments (e.g. a standing reviewer); (c) decomposition will change mid-flight and peers must re-coordinate without routing everything through the parent.
Default: prefer subagents; escalate to sibling sessions only on demonstrated need for peer dialogue. Peer chatter is the #1 token-waster in every studied framework.

### 3.2 Work partitioning
- Partition along FILE/DIRECTORY OWNERSHIP, not thought topics. Every worker brief declares a write-set (glob allow-list); everything outside is read-only. Single most effective conflict-avoidance rule (mirrors Roo-Code mode scoping, MAGIS role scoping).
- Contracts-first (MetaGPT pattern): the parent writes INTERFACE.md / CONTRACT.md into the workspace BEFORE spawning workers. Workers code against the artifact, not against assumptions about each other.
- Keep active workers at 2-4. Debate gains saturate at ~3 agents; MAST shows coordination failures dominate beyond that.
- For a pivotal single decision: spawn N=3 subagents with identical briefs, FORBIDDEN to look at each other, then have the parent or a judge subagent pick the best artifact (sampling+voting, 2402.05120). Do NOT let them debate first ！ debate induces conformity.

### 3.3 Avoiding shared-file conflicts
1. Write-sets in the brief + parent enforcement on merge.
2. Any shared log (progress notes, questions) must be append-only and sharded by writer: .team/notes/agent-id.md ！ no shared mutable file, no locks needed.
3. Task board .team/tasks.json with {id, owner, status, claim}; all writes by the parent acting as registrar; workers claim via team_send. A central registrar beats distributed locking at small team sizes.
4. Message discipline: team_send messages carry file paths + line ranges changed, so peers re-read only what changed instead of re-scanning the tree.

### 3.4 Merging results
- Fan-in at the parent, always. Siblings never merge each others code directly (OpenAI agents-as-tools and LangGraph supervisor both converge on this).
- Merge artifacts, not transcripts: require a fixed report schema ！ summary, files_changed[], key_decisions[], open_issues[], suggested_tests. Parent merges code first, reads reports only for decisions/conflicts.
- Disputed decisions: one fresh judge subagent given only competing diffs + the contract (isolation avoids politics and context contamination).
- Verify after EACH worker merge (build+tests), not once at the end ！ missing/weak verification is MAST's biggest category; MAGISs dedicated QA role drove its gains.

### 3.5 Termination and completion
- Machine-checkable completion criteria in every brief ("done when: tests pass AND report written to X") ！ premature/never termination is a top MAST mode.
- Parent keeps an explicit ledger (Magentic-One pattern): task list with status, updated after each report; completion = ledger all done + verification green.
- Timebox siblings: a team session must answer or explicitly defer within its next turn; unanswered messages escalate to the parent instead of being silently dropped.
- Shutdown protocol: parent broadcasts TEAM_WRAP; each sibling replies with its final artifact list; parent archives .team/ transcript+ledger into a completion note; no sibling may hold pending writes at end.

### 3.6 Prompting patterns that measurably beat single-agent runs
1. Contracts-first decomposition (MetaGPT): parent-authored artifact pinned before workers start ！ highest-leverage pattern for software tasks; reduces cascading hallucination.
2. Independent N-sample + judge for pivotal decisions (2402.05120): 3 isolated attempts, judge on artifacts. Cheap, parallel, reproducible.
3. Verifier-not-author (MAGIS QA; MAST verification finding): review/tests written by a different session than the implementer; self-review is near-worthless.
4. Context isolation for exploration (Claude Code subagent pattern): all search/research via subagents; the parent receives only distilled reports ！ keeps the orchestrator context clean.
5. Artifact-carrying messages: every team_send includes concrete paths/diffs, never pure prose (MetaGPT structured-message finding).
6. Escalation ladder in worker briefs: "if blocked for one step, message the parent with a specific question; do not guess" ！ silent guessing plus parent assuming progress is the classic inter-agent misalignment failure.

### Anti-patterns (do not build these)
- Free-form broadcast chat among all siblings (weakest AutoGen SelectorGroupChat mode).
- Sequential pipeline with no feedback loop (ChatDev waterfall failure).
- Debate before independent answers exist (conformity collapse).
- More than 4 concurrent workers on one task (coordination failure dominates).
- Self-verification as the only quality gate.

Method note: web_search was unavailable in this session (missing API key); github.com was unreachable from web_fetch, so framework facts were cross-checked against official docs domains and papers verified via arXiv abstracts.
