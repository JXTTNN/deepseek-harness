# Open-Source Component Research for DSH — candidate comparisons and embed decisions (2026-09-06)

> Fork-internal research record. Method: ~55 candidate repos compared via live stars/license metadata; picks are MIT/Apache where embeddable. Categories match the goal: drop paid/key-gated or weak parts, embed winners directly into source.

## 1. Web search (keyless fallback)
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| duck-duck-scrape (Snazzah) | github.com/Snazzah/duck-duck-scrape | ~230 | MIT | keyless DDG wrapper; embed pattern |
| SearXNG | github.com/searxng/searxng | 37k+ | AGPL | server-side only (license blocks embedding) |
| Brave Search API | brave.com/search/api | — | key req | free tier but key-gated |
| Tavily | — | — | key req | agent-tuned, paid |
| SerpAPI | — | — | paid | no |
| Wikipedia API | — | free | keyless | good supplemental source |
**Pick:** embed a DuckDuckGo keyless HTML provider (`packages/web/web-search-ddg`) as the zero-config fallback; keep SearXNG mountable; default stays Responses provider.

## 2. Web fetch readability extraction
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| Defuddle | github.com/kepano/defuddle | 9.3k | MIT/TS | native TS, best current extractor |
| Mozilla Readability | github.com/mozilla/readability | 11k | Apache-2 | proven |
| linkedom + turndown | linkedom/turndown | 11k | MIT | already the harness's tool-web core |
| postlight/parser | github.com/postlight/parser | — | unattended | dead |
| trafilatura | github.com/adbar/trafilatura | 5k | Apache-2/Python | wrong runtime |
**Pick:** keep turndown hot path; evaluate Defuddle extraction for web_fetch when enabled (deferred work item).

## 3. Semantic code search (local, free)
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| ripgrep | github.com/BurntSushi/ripgrep | 68k | Unlicense | already harness's grep engine |
| tree-sitter (WASM) | github.com/tree-sitter/tree-sitter | 27k | MIT | structural chunking/symbols |
| transformers.js | github.com/huggingface/transformers.js | 16k | Apache-2 | local ONNX embeddings |
| Orama | github.com/askorama/orama | 11k | Apache-2 | in-memory BM25/vector |
| LanceDB | github.com/lancedb/lancedb | 11k | Apache-2 | ANN index (NAPI) |
**Pick:** dsh already ships ripgrep-backed grep; tree-sitter symbol map remains deferred work item (no paid service anywhere — requirement satisfied by rejecting hosted embeddings).

## 4. Markdown pipeline
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| unified/remark/rehype | github.com/remarkjs | large | MIT | the TS ecosystem core |
| marked | github.com/markedjs/marked | 37k | MIT | fastest single-shot |
| marked-turndown etc. | — | — | — | already used in tool-web |
| markdown-it | github.com/markdown-it/markdown-it | 23k | MIT | pluggable alternative |
| micromark | github.com/micromark | 3k | MIT | composable core of unified |
**Pick:** harness web UI already renders markdown via shiki/unified chain; no replacement needed this round.

## 5. Diff computation & rendering
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| jsdiff | github.com/kpdecker/jsdiff | 9.2k | BSD-3 | stable, small |
| diff2html | github.com/rtfpessoa/diff2html | 3.4k | MIT | web UI rendering |
| fast-diff | github.com/jhchen/fast-diff | 715 | Apache-2 | inline edits |
| diff | — | — | — | (same as jsdiff) |
| meld/kdiff3 | desktop tools | — | GPL | out of scope |
**Pick:** jsdiff for any new in-diff needs; diff2html candidate for the web GUI diff cards (deferred).

## 6. CLI/Web UI layers
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| Ink | github.com/vadimdemedes/ink | 40k | MIT | React-for-CLI (gemini-cli uses it) |
| blessed | github.com/chjj/blessed | dead-ish | MIT | avoid |
| terminal-kit | — | 2k | MIT | fallback |
| Vite + existing client runtime | in-repo | — | — | harness already ships apps/web |
| Tauri | out of scope | — | Apache/MIT | no |
**Pick:** keep the existing client/server shell; mark Ink only if a TUI roadmap emerges.

## 7. Embeddable agent personas/subagent definitions (vendor as source)
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| wshobson/agents | github.com/wshobson/agents | 39k | MIT | ~100 Claude Code subagent definitions — vendoring pattern adopted |
| VoltAgent/awesome-claude-code-subagents | github.com/VoltAgent/awesome-claude-code-subagents | 25k | MIT | index source |
| contains-studio/agents | github.com/contains-studio/agents | 12k | MIT | division-of-labor agents |
| Roo-Code modes | github.com/RooVetGit/Roo-Code | 24k | Apache-2 | mode YAML structure reference |
| OpenAI Agents SDK / Swarm | github.com/openai/swarm | — | MIT | handoff semantics reference |
| Cline modes / Aider personas | — | 68k/49k | — | plan/act split as design input |
**Pick IMPLEMENTED:** embedded 7 skill packs (systematic-debugging, test-driven-work, code-review, security-audit, architecture-and-contracts, verify-before-complete, subagent-partitioning) into the team preset — the skill material is our own adaptation written against these repos' patterns.

## 8. Context compaction
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| mem0 | github.com/mem0ai/mem0 | 65k | Apache-2/py | memory pipeline reference |
| letta | github.com/letta-ai/letta | 25k | —/py | core-memory concept |
| LLMLingua | github.com/microsoft/LLMLingua | 6.6k | py | compression reference |
| sliding-window+summary | internal | — | — | implementable in-house |
| harness compaction package | packages/compaction | — | — | own impl exists |
**Pick:** keep in-repo compaction provider; adopt structured-summary-of-evicted-segments strategy (deferred code item).

## 9. Local/free LLM fallback
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| Ollama | github.com/ollama/ollama | 180k | MIT | local OpenAI-compatible endpoint |
| LiteLLM proxy | github.com/BerriAI/litellm | 58k | MIT | multi-provider escape hatch |
| llama.cpp server | github.com/ggerganov/llama.cpp | 127k | MIT | raw local runtime |
| LocalAI | github.com/mudler/LocalAI | 49k | MIT | turnkey node |
| dsh llm-pi-ai | in-repo | — | — | already OpenAI-compatible adapter |
**Pick:** llm-pi-ai already accepts arbitrary OpenAI-compatible base URLs (this fork's current settings use it); document Ollama as the no-cost fallback route instead of a new adapter (done via docs note).

## 10. Curated skill catalogs
| Candidate | Repo | Stars | License | Verdict |
|---|---|---|---|---|
| obra/superpowers | github.com/obra/superpowers | 282k | MIT | TDD/debugging/verification SKILL.md packs — pattern source |
| anthropic/skills | github.com/anthropics/skills | 175k | MIT | reference library |
| davila7/claude-code-templates | github.com/davila7/claude-code-templates | 31k | MIT | agents/commands catalog |
| hesreallyhim/awesome-claude-code | github.com/hesreallyhim/awesome-claude-code | 54k | — | sourcing index |
| anthropics/awesome-* | — | — | — | supplementary |
**Pick IMPLEMENTED:** see category 7 — 7 skills vendored into the team preset with MIT-compatible original text.

## Compliance notes
- No AGPL code is linked or embedded (SearXNG is run as an external service only).
- Python-only references (mem0, letta, trafilatura, LLMLingua) are design references, not dependencies.
- Full per-candidate metadata is in the research transcript; this file is the committed durable record.
