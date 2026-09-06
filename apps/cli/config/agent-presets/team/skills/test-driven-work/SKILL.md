---
name: test-driven-work
description: Run a red-green-refactor loop adapted for agent sessions — require a failing behavioral test before implementing any bug fix or new behavior, keep tests behavioral, and refactor in small verified steps. Use for feature work and bug fixes in any codebase with a test runner.
---

# Test-Driven Work

For any new behavior or bug fix, the failing test comes first. The test is the executable specification; the implementation exists to satisfy it.

## When a failing test is mandatory

- Every bug fix: reproduce as a failing test BEFORE touching the implementation. No failing test, no fix — you cannot prove the fix works.
- Every new public behavior, and every edge case the user names explicitly.
- Skip the red step only for pure refactors (behavior already covered), docs, config, and mechanical renames. Say which exemption you are using.

## Loop

1. **RED.** Write one behavioral test for the next slice: call the real public API, assert observable output, not internals. Run it and watch it fail — for the right reason. A test failing on a typo or import error is not red; fix the harness, not the assertion.

2. **GREEN.** Write the smallest implementation that passes. Hard-code a value if that is genuinely the next step; never build the final abstraction before a second test demands it.

3. **REFACTOR.** With green tests as the net, clean up: remove duplication, name things, tighten types. Run the test file after each refactor step, not once at the end.

4. **Track the loop.** For multi-slice work keep `todo_write` current — one item per red-green-refactor slice — so an interrupted session resumes at the next test.

## Keeping tests behavioral

- Assert what callers observe: return values, emitted events, written files. Never private fields, call counts of internal helpers, or mock wiring.
- One behavior per test; a name that reads as a sentence about the system ("rejects a config without apiUrl"), not about the method ("testLoad3").
- Tests must pass on a clean checkout: no shared mutable state between tests, no ordering dependence, no `sleep` where an `await` exists.
- A test that sometimes fails is a bug in the test or the code — fix it now, never retry-and-ignore.

## Constraints

- Never weaken an assertion, delete a failing test, or broaden a type to reach green. If behavior genuinely changed, change the test together with the code and say why.
- Keep the loop tight: run the single test file (`pnpm vitest run <file>` or the repo's runner), not the whole suite, until the slice is done.
