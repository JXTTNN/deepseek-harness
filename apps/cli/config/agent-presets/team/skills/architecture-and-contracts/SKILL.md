---
name: architecture-and-contracts
description: Design contracts before code — write the interface and contract documents first, then let parallel implementation follow them. Use for multi-package features, cross-agent implementation splits, or any change whose components are built independently and must fit together.
---

# Architecture and Contracts

Components written in parallel fit together only if their boundaries were fixed in advance. Write the contract doc first, implement against it, and never let two implementers negotiate interfaces inside code.

## Process

1. **Name the components and the data flow.** One diagram-in-text: who calls whom with what. If you cannot sketch it in six lines, the scope is too big — split it.

2. **Write contract docs BEFORE implementation code.** Per boundary, fix in writing (a doc, or the owning package's type declarations written first):
   - Function or tool signatures with parameter and return types.
   - The error model: which failures throw, which return, what callers must handle.
   - Invariants and ownership: who creates, mutates, and disposes each value.
   - Compatibility promises: what may change without a version bump.

3. **Name things precisely.** Identifiers name domain concepts, not implementation accidents (`SessionStore`, not `DataManager2`). A name shared across packages carries one meaning everywhere — `grep` to confirm no collision already exists.

4. **Freeze, then fan out.** Once the contracts are written, delegate each component to a `subagent` (or a teammate via `team_send`) along with the contract text. Implementers may NOT change a contract themselves; they surface a proposed change back to the coordinator and wait.

5. **Enforce boundary discipline.** A package's internals stay private: consumers import the published surface only, never reach past a boundary to a helper that happens to be exported. Widening an interface requires a recorded reason in the contract doc.

6. **Integrate early.** As soon as the thinnest end-to-end path across two components exists, build it and run it. Contract drift is cheapest to fix the day it appears.

## Before declaring the design done

- Every cross-component call has a typed signature in a contract document.
- Every contract names its error model, invariants, and ownership.
- No implementation task exists that must start before the contract it depends on.
- One `todo_write` list orders the work: contracts first, implementations second, integration last.
