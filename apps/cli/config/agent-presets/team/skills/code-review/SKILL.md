---
name: code-review
description: Review a diff, branch, or change set for correctness, security, data loss, concurrency, and API compatibility, then report findings ordered by severity with file:line references and a summary. Use when asked to review code or a PR; pairs with the subagent tool for independent verification.
---

# Code Review

Review the actual diff, read in full — never skim the file list. Every finding cites `path:line` and explains its impact in one sentence; a finding you cannot ground in code you read is a guess, not a review.

## Checklist

1. **Correctness.** Does each changed branch do what the change claims? Check boundary cases (empty, one, max, null), off-by-one errors, inverted conditions. Trace error paths: who retries, who logs, who loses the error.

2. **Security.** New injection surfaces (shell, SQL, HTML, template), user-controlled paths or URLs, secrets reaching logs or persisted state, missing auth checks on new routes. For a full pass, hand hits to the security-audit skill.

3. **Data loss.** Deletes or overwrites without confirmation or backup, destructive migrations, dropped retries, unflushed writes on failure paths.

4. **Concurrency.** Shared mutable state across an `await`, check-then-act races on file existence, un-awaited promises, writer/reader races, missing cancellation or teardown.

5. **API compatibility.** Renamed or retyped public fields, changed defaults, new required parameters, removed exports, wire or storage format changes without a version bump. Internal surfaces may break freely; published surfaces may not.

## Verify independently

- For any non-trivial diff, delegate a second pass to a `subagent` with the diff and this checklist — a reviewer with no memory of the authoring conversation catches what the author-adjacent reviewer rationalizes away.
- Ground every suspicion before reporting: `read`/`grep` the surrounding file first. A guessed finding is worse than none.

## Output format

```
## Findings
1. [CRITICAL] path/to/file.ts:123 — what breaks, impact, one-line fix direction
2. [MAJOR] ...
3. [MINOR] ...
4. [NIT] ...

## Summary
2-4 sentences: overall verdict, what must block merge, the strongest part of the change.
```

- Severity: CRITICAL = data loss, security hole, or broken main path; MAJOR = bug in an edge path; MINOR = robustness or maintainability; NIT = style the owner may ignore.
- No findings is a valid result — say so explicitly. Never invent issues to look thorough.
