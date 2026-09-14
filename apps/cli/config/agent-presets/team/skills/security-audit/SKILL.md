---
name: security-audit
description: Audit code for common vulnerabilities — injection, secrets in logs, path traversal, SSRF, auth bypass, unsafe deserialization — using grep-driven evidence gathering. Use when asked to check code for security issues or before shipping a surface that handles untrusted input.
---

# Security Audit

Evidence first: every finding cites a `grep` hit plus the lines read around it. Concentrate on where outside data enters the process, not the whole codebase uniformly.

## Hunt list

1. **Injection.** Shell or file-command construction, SQL string concatenation, template/HTML interpolation, dynamic evaluation.
   - `grep` for: `exec`, `spawn`, `eval(`, `new Function`, `query(`, `innerHTML`, template literals interpolated into commands.

2. **Secrets in logs and errors.** Tokens, keys, cookies, auth headers reaching logs, thrown errors, or persisted session data.
   - `grep` for `console.|logger|log(` near `token|secret|password|authorization|api[-_]?key`; check `.env` values interpolated into messages.

3. **Path traversal.** User-controlled segments joined into filesystem paths without normalization and a containment check.
   - `grep` for `join(`/`resolve(` near request or parameter values; look for a `resolve` followed by a `startsWith(root)` anchor.

4. **SSRF.** User-influenced URLs fetched server-side.
   - `grep` for `fetch(`/`http.request` with a non-constant URL; check for a scheme/host allowlist.

5. **Auth and access bypass.** A new route or tool missing the guard its siblings have; permission checks done client-side only; default-allow on unrecognized values.
   - Compare siblings: enumerate the handlers, find the one lacking the shared guard line.

6. **Unsafe deserialization.** `JSON.parse` of untrusted input merged into objects by key; deep `Object.assign(target, userData)`.

## Method

1. List entry points first (routes, CLI flags, tool parameters, webhooks) — audit effort concentrates at boundaries.
2. For each hunt-list item, run the greps, then `read` the 20 lines around every hit before judging: most hits are safe by construction; report only real ones.
3. State exploitability in one sentence per finding: who controls the value, where it lands, what breaks. Missing any of the three makes it a hardening note, not a finding.
4. For large surfaces, fan the categories out to `subagent`s (one category each, same grep-first discipline), then merge — dedupe overlapping hits before writing up.

## Output

- Findings ordered by severity with `file:line`, the affected entry point, and a concrete fix direction.
- Close with an exposure summary: which entry points were covered, which were intentionally out of scope.
- Never quote real secret VALUES in the report — cite the `file:line` where the value leaks instead.
