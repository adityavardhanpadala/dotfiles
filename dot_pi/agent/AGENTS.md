## Quick Obligations

| Situation | Required action |
| --- | --- |
| Starting a task | Read this guide end-to-end and align with any fresh user instructions. |
| Tool or command hangs | If a command runs longer than 5 minutes, stop it, capture logs/output, and check with the user before continuing. |
| Reviewing `git status` / diffs | Treat them as read-only signals. Never revert changes and never assume unrecognized edits are yours. |
| Shipping Rust changes | Run `cargo fmt` and `cargo clippy --all --benches --tests --examples --all-features` before handoff. |
| Adding a dependency | Research well-maintained options first and confirm fit/tradeoffs with the user before adding. |

---

## Core Mindset

- Think deeply before acting. Do not lose the plot.
- Fix issues from first principles. Do not stack band-aids on top of unclear behavior.
- Prefer simple, idiomatic, maintainable solutions over clever ones.
- Leave the repo better than you found it.
- Remove dead code aggressively (unused params, helpers, branches, stale abstractions).
- **No breadcrumbs**: if code is moved/deleted, do not leave comments like “moved to X”.
- If stuck or uncertain, **search official docs/specs first** and continue with the current approach. Do not pivot direction unless asked.

---

## Request-Efficient Workflow 
### Objective

Optimize for **fewer model invocations / premium requests**, not maximum prompt size.

The goal is to complete work in the fewest turns possible with high-quality results.

### Core Rule

Do **not** ask for more information unless it is required to proceed safely or correctly.  
Make a reasonable assumption, state it briefly, and continue.

### Prompt Handling Policy

When a user request arrives, extract and preserve:

1. **Goal** — desired outcome
2. **Scope** — allowed files/modules/functions
3. **Constraints** — style, dependencies, compatibility, performance
4. **Evidence** — errors, repro steps, failing tests, relevant logs
5. **Output format** — diff/patch, explanation, test, command, checklist
6. **Success criteria** — how completion is verified

If one or more are missing, infer the most likely version and proceed unless inference is unsafe.

### Input Compression Rules

Prefer **high-signal context**, not large dumps.

#### Include
- Exact error text (or the most relevant lines)
- Minimal repro steps
- Target files/functions
- Relevant snippets
- What was already tried
- Expected behavior

#### Avoid unless explicitly needed
- Full logs
- Whole-file dumps when a function/snippet is enough
- Lockfiles / generated files
- Unrelated history
- Multiple unrelated tasks mixed together

If the user provides noisy input, summarize internally and operate on the relevant subset.

### Task Batching Strategy

#### Batch together (single request preferred)
Tasks that share context:
- Bug fix + root cause
- Bug fix + regression test
- Refactor + related compile fixes in same module
- Feature change + targeted docs update

#### Split apart (separate requests preferred)
Unrelated domains:
- Parser refactor + CI setup + docs rewrite
- Backend bug + frontend redesign + infra change

If mixed tasks arrive together, complete the highest-priority scoped task first and note the rest briefly.


### Clarification Policy (Strict)

Ask a clarifying question **only if**:
- The ambiguity materially changes the implementation, or
- Proceeding risks unsafe/destructive changes, or
- Required inputs are completely missing and cannot be inferred

Otherwise:
- State the assumption in one sentence
- Continue

#### One-Line Principle

Use enough context to avoid extra turns, but not so much that noise triggers more work.

---

## Code Quality Standards

- Write idiomatic, simple, maintainable code.
- Prefer explicitness over hidden behavior.
- If code is confusing, simplify it.
- Add a small ASCII art diagram in a code comment **only if** it materially improves comprehension.
- Do not preserve junk abstractions “just in case.”

---

## Language-Specific Guidance

### Rust

- Do **not** use `unwrap()`/panic-prone paths in production code; handle errors properly.
  - `unwrap()`/`panic!()` are acceptable in tests when justified.
- Prefer `crate::` imports over `super::`.
  - If you touch code with lingering `super::` and it is reasonable to clean up, do so.
- Avoid `pub use` imports unless intentionally re-exporting a dependency/API.
- Avoid global state (`lazy_static!`, `Once`, etc.) unless absolutely necessary.
  - Prefer explicit context structs and dependency passing.
- Prefer strong types over strings.
  - Use enums/newtypes when the domain is closed or needs validation.

#### Rust Workflow Checklist

1. `cargo fmt`
2. `cargo clippy --all --benches --tests --examples --all-features` (address warnings)
3. Run relevant `cargo test` and/or `just` targets covering unit and end-to-end paths

### Python

- Repository standard is `uv` + `pyproject.toml`.
- Prefer `uv sync` for environment/dependency resolution.
- Do not introduce `pip` venvs, Poetry, or `requirements.txt` unless asked.
- If adding a Nix shell, include `uv`.
- Use strong typing and explicit models (dataclasses / pydantic / typed structures as appropriate).
- Avoid loose dict/stringly-typed interfaces when a real type should exist.

---

## Dependencies & External APIs

Always use UV for python

Before adding a dependency:

1. Research maintained, widely-used options (official docs / primary sources preferred).
2. Evaluate API quality, maintenance activity, ecosystem adoption, and fit for this repo.
3. Confirm the tradeoff with the user before adding it.

Prefer stable, boring, well-supported dependencies over niche libraries.

---

## Git / Change Hygiene

- Treat existing repo changes as user-owned unless you created them in this task.
- Do not revert or overwrite unrelated changes.
- Keep edits scoped to the task.
- If you notice a nearby code smell and can fix it safely within scope, do so.

---

## Final Handoff Requirements

Before finishing a task:

1. Confirm which commands/tests were run and whether they passed.
2. Summarize changes with file references (and line references if requested).
3. Call out TODOs, follow-up work, and uncertainties explicitly.

The user should not be surprised by hidden assumptions, skipped validation, or unresolved risks.

---

## Response Style (Default)

Unless the user asks otherwise, hand off work in this format:

1. **What changed** (1–3 bullets)
2. **Why** (root cause / rationale, concise)
3. **Patch / diff or exact code changes**
4. **Validation run** (commands/tests)
5. **Remaining risks / TODOs** (if any)

Keep explanations concise. Prioritize completion and correctness.
