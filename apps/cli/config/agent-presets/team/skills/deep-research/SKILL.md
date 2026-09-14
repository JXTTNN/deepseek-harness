---
name: deep-research
description: Run a multi-step deep-research investigation and produce a cited, structured report. Use this skill when the user asks for a comparison, market/competitor analysis, a survey of a topic, or any "research and summarize" task that needs more than a single web_search call. For a single factual lookup, search directly instead.
---

# Deep Research

Turn a broad question into a cited, structured report through an explicit research loop: clarify scope, convert it into a concrete research question, fan out parallel sub-research through subagents, then synthesize and cite. Never dump raw search snippets as the answer.

## Workflow

1. **Clarify only if genuinely ambiguous.** If the request already names the subject, purpose, and depth, proceed. Otherwise ask ONE concise `ask_user_question` (acronyms, scope, audience, or time horizon) and then proceed. Do not re-ask what is already answered.

2. **Convert to a concrete research question.** Write one sentence that folds in every constraint the user gave (language, geography, time window, product category, etc.). If a dimension is essential but unspecified, treat it as open-ended rather than inventing a value.

3. **Decompose into independent subtopics.** Split the question into 3–6 self-contained angles (e.g. market players, pricing, technical trade-offs, reviews, risks). Each angle must be answerable alone.

4. **Fan out in parallel.** Delegate each angle to a DIFFERENT `subagent` (never serialize what can run concurrently). Each worker: runs `web_search` for its angle, reads the top results, and returns 3–6 findings with source URLs. Prefer official/primary sources (vendor pages, original papers, official docs) over aggregator or SEO blogs.

5. **Collect and cross-verify.** Merge the workers' findings. For any claim that matters, keep its source URL attached; drop or mark unverifiable claims. If two workers disagree on a key fact, note the conflict.

6. **Write the report.** Structure it as: executive summary, findings by angle, comparison table where the question is a comparison, key risks/uncertainties, and a Sources section listing every cited URL. Keep claims adjacent to their citations.

## Constraints

- Every factual claim in the report must trace to a URL returned by `web_search`; never fabricate a URL or a statistic.
- If the question is a comparison, always include a table (rows = options, columns = the user's criteria).
- Mark uncertain or conflicting information explicitly; do not present a weak signal as settled fact.
- Keep the report scannable: short paragraphs, headings, bullets. A long report is fine, a wall of unbroken text is not.
