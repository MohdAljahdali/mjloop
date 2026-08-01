# Execution Report: Project-Aware Skill Orchestration

**Plan:** `2026-07-30-mjloop-project-aware-skill-orchestration.md`
**Review:** `2026-07-30-mjloop-project-aware-skill-orchestration-review.md`
**Stories:** `2026-07-30-mjloop-project-aware-skill-orchestration-execution-stories/S01`–`S08`
**Executed:** 2026-07-31 → 2026-08-01
**Branch:** `feat/project-aware-skill-orchestration` → PR #1
**Outcome:** S01–S07 delivered. S08 not attempted — blocked, by its own stop condition.

---

## 1. What shipped

| Commit | Story | Tests, verified at that commit alone |
|---|---|---|
| — | S01 — baseline and safety gate | 1130 (the baseline itself) |
| `05e8eb2` | S02 — component map + orchestration policy | 1303 |
| `4273b71` | S03 — the feature-discovery interview | 1327 |
| `83d3917` | S04 — immutable feature briefs | 1443 |
| `e2e3567` | S05 — skill selection, pinned to the run | 1533 |
| `4d893ca` | S06 — shared library, per-project activation | 1632 |
| `2122f71` | S07 — external discovery, audit, sandbox | 1707 |
| `e81073c` | control-center slice + the approval it blocked | 1738 |
| `d04116e` | regenerate the shipped bundle | 1738 |

Baseline before the work: **57 test files, 1130 tests**. Final: **73 files, 1738 tests**. Zero regressions
at any point — no suite that was green went red.

Every row's test count was measured by checking that commit out into a **detached worktree** and running
`npm run typecheck` and the full suite there. A commit that only passes at the tip of the branch is not a
commit that passes; each of these stands on its own.

### The feature, in one paragraph

A project scans itself into a **component map** — technology decided only by what a manifest declares,
never by a directory name — which a person accepts as an immutable numbered revision. `/mjloop:plan` can
run an **interview** first that asks decisions and looks facts up itself, stopping at a draft. The draft
becomes an **immutable feature brief** whose approval compare-and-swaps its content digest. From an
approved brief the engine **selects skills** for the existing fixed agent roles and pins that decision into
the run directory. Skills come from a **user-local library shared across projects**, activated per project
by digest, and reach that library through a **pipeline of refusals**: pinned revision, bounded fetch, static
audit, sandbox or refusal.

Agent roles are unchanged. There is no `flutter-builder`, and a test refuses one under every spelling
(`flutter-builder`, `flutter_builder`, `builder-flutter`).

---

## 2. How it was executed

Each story ran as a multi-agent workflow with a **locked design** written before any agent started —
schemas, file ownership, and the decisions the story left open, all settled up front so parallel
implementers could not diverge. The shape per story:

```
implement (parallel, disjoint file sets)
  → wire → docs
  → verify (independent; runs the commands and reports what actually happened)
  → adversarial review on three independent lenses
  → refutation pass (one judge per finding, default verdict "refuted")
  → repair (failing test written before each fix)
```

From S05 onward, implementation ran on Sonnet and orchestration, verification, review, judging and repair
on Opus, at the operator's request. The locked design is what made that split safe: implementers had no
architectural decisions left to make.

**Approximately 168 subagents across eight workflow runs.**

### Review yield

| Story | Candidate findings | Survived refutation |
|---|---|---|
| S02 (three rounds) | 25 | 8 |
| S03 | 16 | 9 |
| S04 | 10 | 5 |
| S05 | 20 | 13 |
| S06 | 14 | 6 |
| S07 | 25 | **25** |

Every confirmed finding was repaired with a test written and watched failing *first*, and the load-bearing
ones were mutation-verified: break the implementation, confirm the suite goes red on exactly the intended
rows, restore, confirm the diff is clean.

---

## 3. The defects that mattered

Ordered by what they would have cost, not by when they were found.

**The whole feature was inert, three times over.** `acceptProfile` had exactly one production caller —
init's auto-accept branch, gated on a setting that defaults to `false` and firing at most once — so no
project could ever obtain a component map, and none could ever supersede one. Rollback was documented but
unreachable: `profile accept` could only accept whatever the working tree currently scanned to, and the test
named "rollback" passed only by calling a store function through a back door the PreToolUse guard denies to
users. And `resolveSkillManifest` passed a hard-coded empty list of accepted skills with **no test guarding
it** — reverting the one line the story existed to write left the entire suite green.

**Approval compare-and-swap was vacuous.** A feature brief's approval carried the revision number the
approver had seen. But a draft is edited in place, so the number cannot move while the record is mutable:
a brief rewritten between being read and being approved was approved anyway — the exact case the
documentation said was refused. It now compare-and-swaps a sha256 of the content, following
`config.patch`'s existing precedent.

**Concurrency policy was inverted.** `analyseConcurrency` consulted `uncertain_concurrency` only where
independence was already *proven*, and hard-coded `sequential` in the unproven case the setting is
documented to govern. A project that asked for parallel got sequential in precisely the situation it asked
about.

**The PreToolUse guard was bypassable with the shift key.** Path segments were compared case-sensitively,
and this repository lives on a case-insensitive volume. `.mjloop/State.json`, `.mjloop/Profile/…`,
`.mjloop/Features/…` and `.MJLOOP/…` all named the exact files the guard exists to protect and all returned
"allowed". The basename half of that hole predated this plan.

**S07's sandbox claimed a boundary it did not have.** Three findings, each independently sufficient to void
the isolation claim: the backend was spawned by bare name resolved from the inherited `PATH` rather than the
absolute path detection had verified, so anything earlier on `PATH` silently became "the sandbox"; the
darwin seatbelt profile granted `(allow file-read*)` over the whole filesystem, so a package-declared smoke
check could read the project checkout and `~/.ssh` and have its output captured into a report the CLI
prints; and the timeout bounded nothing, because the check settled only on `'close'` and the kill reached
only the direct child.

**S07's import audited one fetch and stored another.** Inspection computed the digest, the file list and the
executable classification from one fetch; staging then re-fetched and wrote *those* bytes, with nothing
comparing them. A sandbox verdict could describe a package nobody stored. The staged bytes are now
re-hashed against the audited digest and refused on mismatch.

**Skill ids were an unchecked claim.** The story's stop condition forbids a model naming a skill outside the
validated selection, and the only thing enforcing it was a sentence in a markdown file — the exact category
of free-form claim the pinned manifest exists to replace. Logging
`skills_used: ['a-skill-nobody-ever-accepted', '../../etc/passwd']` was accepted and stored. `runLog` now
joins against the run's pinned manifest.

---

## 4. The method finding worth keeping

**Automated refutation judges systematically over-refute one class of finding: a capability the plan
requires that nothing actually exposes.** They check that a store function exists and call the finding
refuted, without checking whether a real user can reach it.

Five high-severity findings were refuted by the judges and confirmed correct on manual re-check. All five
were that same class, and three of them are in section 3 above as "the whole feature was inert". A sixth
was never judged at all — its judge died mid-stream, so the finding was silently dropped rather than
refuted, and it too was real.

Two mitigations were adopted mid-plan and both worked:

1. **Re-check every refuted high-severity finding by hand** before committing. This is what caught all five.
2. **Instruct judges to be generous rather than skeptical** toward (a) capabilities no shipped command
   exposes and (b) tests that stay green under a mutation breaking what they claim to guard. For S07 a third
   was added: any plausible path by which untrusted content reaches execution, the network, the project
   directory or the parent environment is refuted **only by showing the path is closed** — "it looks
   unlikely" is not a refutation. S07's yield went to 25 of 25.

A second, smaller finding: **workflow agents die, and they die at the end.** Two repair agents were lost —
one to a network drop, one to a stalled stream — both *after* completing their edits and during their final
verification run. In both cases the work was intact and only the evidence was missing. Checking what
actually landed before assuming loss recovered both. Later repair prompts were changed to print verification
output as soon as it completes rather than at the end of a long summary.

---

## 5. Verification evidence

At the branch tip, from `engine/`:

- `npm run typecheck` — clean (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.web.json`).
- `npx vitest run` — **73 files, 1738 tests**, all passing.
- `npm run build` — bundle regenerated.
- `npm run verify:ship` — 14 checks pass on the staged tree: the MCP server lists its tools, all three hooks
  answer, the PreToolUse guard still denies a `state.json` write, `dist` mirrors `src/web/public` byte for
  byte, ships nothing the source tree lacks, and every import and asset reference resolves **with nothing
  installed**.

The shipped CLI was exercised against this repository rather than trusted from the build log:

```
$ node engine/dist/cli/index.js profile show --dir .
no component map is accepted — nothing is routed by component until one is
no proposal on record — run mjloop init to scan the project
```

### The bundle was the last real blocker

`engine/dist/**` had not been rebuilt since 2026-07-30. The hooks and `docs/install.md` invoke
`engine/dist/cli/index.js` by path, and that file dispatched only `summary`, `session-start`, `state-guard`
and `stop-guard`. **Every command these seven stories added existed in source and nowhere a user could reach
them** — the same "inert capability" failure as section 3, one layer down, at packaging. It also predated
`closing` and `map` on a track, which is why every session in this repository opened with
`config error: Unrecognized keys: "closing", "map"` against a config the engine's own source accepts. Both
are resolved.

Regeneration was deliberately held until last: it mirrors the whole source tree, and the control-center
slice it also mirrors only stopped moving in the commit before it.

---

## 6. Working-tree discipline

The repository was dirty at the start with 52 paths of unrelated in-flight control-center work. The plan
makes preserving it a hard gate, and the operator's instruction was explicit: no control-center change
enters a feature commit.

Five files carried both that work and this feature's, interleaved beyond safe hunk-splitting
(`panels/config.js` at 24 hunks, `index.html` at 40, both locale files at 12 each, `panels.test.ts` at 19).
Those were deferred and landed later in `e81073c`, together with the S04 cockpit approval write that could
not be separated from them.

The two usage documents *were* separable, and were split on every commit by reverting the identified
control-center hunks positionally and staging exact content through `git hash-object` + `git update-index`.
Both directions were verified each time: zero control-center markers in what was committed, zero feature
markers in what remained. An earlier attempt using `git apply --unidiff-zero` misplaced a moved section and
was discarded rather than shipped.

The working tree is now clean — 0 uncommitted paths.

---

## 7. What was not done

**S08 (host adaptation) is blocked and was skipped by operator decision.** Its prerequisite — the
multi-platform migration plan — has never started: there is no `engine/src/platform`, no adapter registry,
no canonical definition set, no capability probes, no installation receipts. S08's own stop condition
governs: *remain blocked rather than emulate a platform by copying Claude files.* Unblocking it is a
separate plan's worth of work, not a task within this one.

The end-to-end lifecycle fixtures in master-plan Task 8 were part of S08 and are therefore also not built.

**Deliberate limitations, documented rather than hidden:**

- No package can pass an audit on a machine with no `sandbox-exec` (darwin) or `bwrap` (linux). An
  executable package there is **refused, not run** — a bare `spawn` with a scrubbed environment is not
  isolation and this implementation does not call one a sandbox.
- General web search is opt-in and no provider is wired; enabling it raises an explicit
  "unavailable" rather than a faked connector.
- Registry *content* fetch is unimplemented — only registry `/search` has a defined contract — and is
  refused honestly rather than guessed at.
- `skills accept` on a project with no accepted component map writes an inert acceptance rather than
  refusing, because a project may legitimately accept skills before it accepts a map; the state is visible
  in `skills list` rather than silent.

**Not attempted at all:** opt-in real-host smoke tests, and any UI beyond read-only views — activating a
skill or accepting a map changes what every later run is told, which is the class of write the browser is
permanently denied.
