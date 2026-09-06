---
name: verify-before-complete
description: Prove work is done before reporting it — build, targeted tests, GitHub CI status via gh, and an evidence diff. Use before telling the user any change is complete, before every commit, and when resuming interrupted work. Never claim "done" on intent.
---

# Verify Before Complete

"Done" means commands ran and their output is in the transcript. Anything else is a claim about the future.

## Completion checklist

Run every applicable row and keep the output tail as evidence:

1. **Build.** The repo's build (e.g. `pnpm run build`, or the narrower equivalent the repo documents) exits 0. Skippable for pure docs/skill changes — but say that you skipped it and why.

2. **Targeted tests.** The narrowest suite that covers the change (one file, one `-t` filter) passes. The full suite runs only for cross-cutting changes; state which level you used and why.

3. **Cloud state.** When the work touches a pushed branch or PR: `gh run list --branch <name> --limit 5`, and `gh run watch` the in-flight run if a merge depends on it. A green local suite is not green CI.

4. **Evidence diff.** `git status` plus `git diff --stat`: exactly the intended files changed, no debug leftovers, no `console.log` debris, no half-finished renames, and every new file the report mentions actually exists where it says.

5. **Behavioral spot check.** For user-visible changes, run the thing once — start the command, hit the endpoint, open the document — and report what you saw, not what you expected to see.

## Reporting rules

- Report commands and verdicts: "`pnpm run typecheck` — pass". Never "should pass", "will now work", or "everything looks good" as a substitute for a run.
- If a check failed and you fixed it, report the failure AND the fix, not just the final green.
- If you could not run a check (missing key, sandbox limit, time), name the unverified check explicitly. An unverified item is not "done"; it is "expected to be fine".
- Match the claim to the evidence: "compiles" after a build, "tests pass" after tests, "works" after a behavioral run. Never upgrade one into the other.

## Anti-patterns

- Declaring success after an edit without re-running the check that edit affects.
- Treating a previous session's green result as current evidence.
- Marking the last `todo_write` item completed before its verification ran.
