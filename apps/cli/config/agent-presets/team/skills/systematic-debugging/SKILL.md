---
name: systematic-debugging
description: Debug root-cause-first — reproduce reliably, form ranked hypotheses, test the cheapest probe first, fix the root cause (never a symptom), then add a regression test and check neighboring cases. Use for every bug, test failure, crash, or flaky behavior instead of guess-and-patch.
---

# Systematic Debugging

Never patch symptoms. Diagnose until you can state the mechanism that produces the bug, then fix that mechanism once.

## Loop

1. **Reproduce deterministically.** Run the failing command (`pwsh`, `run_code`, or the project's test runner) until you have a reliable trigger. If it is flaky, run it 5–10 times and record the failure rate — intermittent bugs need timing or environment hypotheses, not more retries.

2. **Read the actual error.** Capture the full stderr/stdout, exit code, and first failing assertion — never a paraphrase. On Windows, a bare `[exit code: 1]` after an interruption is a termination, not a failure; re-run before diagnosing.

3. **Form ranked hypotheses.** Write a one-line hypothesis per plausible cause ("X fails because A"), ranked by likelihood and by cost to check. More than three means you have not localized yet — add one probe near the failure site first.

4. **Probe the cheapest test first.** In order: `grep`/`read` of the relevant code and config, a log line or `console.log` at the suspected boundary, a minimal standalone repro, and only then a debugger. Test ONE hypothesis per probe so the result is unambiguous.

5. **Fix the root cause.** The fix must explain both the failure and why the code ever worked. If the fix is "also handle case X in the caller", ask whether the callee's contract is the real defect. Never silence the symptom with an empty catch, a broadened type, or a skipped test.

6. **Add a regression test.** It fails before your fix and passes after — behavioral, at the level the bug was observed. Then re-run the original reproduction end-to-end.

7. **Check the neighbors.** `grep` for the same pattern elsewhere: copied call sites, sibling branches, mirrored conditionals. Fix each, or justify why it is genuinely different.

## Anti-patterns

- Editing code before you can reproduce the failure.
- Two speculative fixes in one edit: if it turns green, you cannot say which one mattered.
- "It works now" as the explanation — without the mechanism, the bug is dormant, not gone.
- Broadening an `any`, swallowing an exception, or loosening an assertion to make the red go away.
