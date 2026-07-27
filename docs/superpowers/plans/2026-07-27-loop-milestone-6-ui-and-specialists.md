# Loop — Milestone 6: UI and Specialists — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a cycle depth — five conditional agents that ask whether a change is secure, documented, fast, and consistent with how the product looks — and the design system they read from.

**Architecture:** The five agents reach a cycle through track config alone; the engine learns exactly one new rule, `specialists: never`, and that rule names no agent. The design system is extracted from the code by `ui-designer` on `/loop:design-sync`, never generated from a template and never stubbed at init.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-27-loop-milestone-6-ui-and-specialists-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json` or any `manifest.json`.
- **The engine does not know agent names.** Any rule naming a specific agent belongs in track config.
- **Every judgement inside a `store.update` callback reads the locked draft**, never a pre-lock snapshot.
- **A guard that cannot read its inputs allows the action.**
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/ops/roster.ts` | Reject a roster selecting an agent configured `never` |
| `engine/src/schemas/config.ts` | The five agents into the track availables; a refinement catching `required` versus `never` |
| `engine/src/ops/summary.ts` | `design_system: boolean` |
| `agents/ui-designer.md`, `ui-critic.md`, `security.md`, `docs.md`, `perf.md` | **New.** Five conditional agents |
| `commands/design-sync.md` | **New.** `/loop:design-sync` |
| `skills/loop-leader/SKILL.md`, `skills/loop-state/SKILL.md` | Drafting rules, UI ordering, the new file in the layout |
| `tests/fixtures/tiny-app/src/tokens.css`, `src/card.js` | **New.** Something for an extraction to find |
| `engine/tests/integration/specialists.test.ts` | **New.** A UI cycle, and `never` holding |
| `tests/e2e/run-design-sync.sh` | **New.** Opt-in real-CLI smoke test |

---

## Task 1: `never` enforced

**Files:**
- Modify: `engine/src/ops/roster.ts`, `engine/src/schemas/config.ts`
- Test: `engine/tests/ops/roster.test.ts`, `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: `SpecialistModeSchema`, `forcedSpecialists` from `engine/src/schemas/config.ts`.
- Produces: `forbiddenSpecialists(config: Config): string[]`; `rosterSet` rejects a selected `never` specialist; `ConfigSchema` rejects a track whose `required` names a `never` specialist.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/ops/roster.test.ts`:

```ts
describe('specialists configured never', () => {
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.tracks.edit = { required: ['editor', 'verifier'], available: ['critic', 'scout'], max_cycles: 3 }
    config.specialists = { critic: 'never' }
    await writeConfig(project.dir, config)
  })

  it('rejects a roster that selects one', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'critic'], skipped: { scout: 'known files' } }),
    ).rejects.toBeInstanceOf(RosterViolationError)
  })

  it('names the agent and the setting', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'verifier', 'critic'], skipped: { scout: 'known files' } }),
    ).rejects.toThrow(/critic[\s\S]*never/)
  })

  it('accepts a roster that omits it, with no reason required', async () => {
    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier'],
      skipped: { scout: 'known files' },
    })
    expect(result.path).toContain('roster.json')
  })

  it('leaves auto and unset specialists alone', async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { critic: 'auto' }
    await writeConfig(project.dir, config)

    const result = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['editor', 'verifier', 'critic'],
      skipped: { scout: 'known files' },
    })
    expect(result.path).toContain('roster.json')
  })

  it('aggregates with other violations rather than short-circuiting', async () => {
    await expect(
      rosterSet(project.dir, { cycle: 1, selected: ['editor', 'critic'], skipped: {} }),
    ).rejects.toThrow(/verifier[\s\S]*critic|critic[\s\S]*verifier/)
  })
})
```

Add to `engine/tests/schemas/config.test.ts`, inside `describe('ConfigSchema', ...)`:

```ts
  it('rejects a track requiring an agent the config forbids', () => {
    const bad = {
      version: 1,
      tracks: { edit: { required: ['editor', 'verifier'], max_cycles: 1 } },
      specialists: { verifier: 'never' },
    }
    const parsed = ConfigSchema.safeParse(bad)
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      const message = z.prettifyError(parsed.error)
      expect(message).toContain('verifier')
      expect(message).toContain('edit')
    }
  })

  it('allows a never specialist that no track requires', () => {
    const good = {
      version: 1,
      tracks: { edit: { required: ['editor', 'verifier'], available: ['critic'], max_cycles: 1 } },
      specialists: { critic: 'never' },
    }
    expect(ConfigSchema.safeParse(good).success).toBe(true)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/ops/roster.test.ts tests/schemas/config.test.ts`
Expected: FAIL — a `never` specialist is accepted in a roster, and the contradictory config parses.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/config.ts`, add the helper beside `forcedSpecialists`:

```ts
/**
 * Specialists the project has forbidden. The mirror image of
 * `forcedSpecialists`: one says an agent cannot be dropped, this says it
 * cannot be drafted. Both return names the engine never interprets.
 */
export function forbiddenSpecialists(config: Config): string[] {
  return Object.entries(config.specialists)
    .filter(([, mode]) => mode === 'never')
    .map(([name]) => name)
}
```

Add a refinement to `ConfigSchema` catching the contradiction. It must sit on the whole
config rather than on `TrackSchema`, because a track cannot see the `specialists` map:

```ts
  .superRefine((config, ctx) => {
    const forbidden = new Set(
      Object.entries(config.specialists)
        .filter(([, mode]) => mode === 'never')
        .map(([name]) => name),
    )
    for (const [trackName, track] of Object.entries(config.tracks)) {
      for (const agent of track.required) {
        if (forbidden.has(agent)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tracks', trackName, 'required'],
            message: `"${agent}" is required by track "${trackName}" but specialists.${agent} is "never" — every possible roster for that track would be rejected. Drop one of the two.`,
          })
        }
      }
    }
  })
```

In `engine/src/ops/roster.ts`, import the helper and add the rule beside the forced check:

```ts
import { findTrack, forbiddenSpecialists, forcedSpecialists, permittedAgents } from '../schemas/config.js'
```

```ts
  const forbidden = forbiddenSpecialists(config)
```

```ts
  // The mirror of the forced rule above: `always` means it cannot be dropped,
  // `never` means it cannot be drafted. Before this the config accepted three
  // modes and enforced one, so a project asking for no security review got one
  // whenever the leader felt like drafting it.
  for (const agent of forbidden) {
    if (selected.has(agent)) {
      violations.push(`"${agent}" is configured as specialists.${agent}=never and cannot be drafted`)
    }
  }
```

Place it after the forced loop and before the permitted check, so all violations still
aggregate into one message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green. If a `ConfigSchema` consumer breaks because the schema
is now refined, the fix is at the call site: a refined schema still parses to the same
type.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/roster.ts engine/src/schemas/config.ts engine/tests
git commit -m "feat(engine): enforce specialists configured never"
```

---

## Task 2: The specialists reach the tracks

**Files:**
- Modify: `engine/src/schemas/config.ts`
- Test: `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_TRACKS`.
- Produces: `build.available` with seven agents; `fix.available` with `security`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/schemas/config.test.ts`, inside `describe('DEFAULT_TRACKS', ...)`:

```ts
  it('offers every specialist to the build track', () => {
    expect(DEFAULT_TRACKS.build?.available).toEqual([
      'scout',
      'critic',
      'ui-designer',
      'ui-critic',
      'security',
      'docs',
      'perf',
    ])
  })

  it('offers security to the fix track', () => {
    expect(DEFAULT_TRACKS.fix?.available).toContain('security')
  })

  it('leaves the edit track deliberately bare', () => {
    expect(DEFAULT_TRACKS.edit?.available).toEqual([])
  })
```

Add a test that every agent the defaults name has a file, since a track naming a missing
agent is a real defect and nothing else catches it:

```ts
  it('names only agents that exist', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const url = await import('node:url')
    const agentsDir = path.resolve(url.fileURLToPath(import.meta.url), '../../../../agents')
    const shipped = new Set(
      (await fs.readdir(agentsDir)).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')),
    )

    for (const [name, track] of Object.entries(DEFAULT_TRACKS)) {
      for (const agent of [...track.required, ...track.available]) {
        expect(shipped.has(agent), `track ${name} names ${agent}, which has no agent file`).toBe(true)
      }
    }
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts`
Expected: FAIL — the availables are short and five agent files do not exist yet. The
last test stays red until Task 3 ships the agent files; that is expected and correct.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/config.ts`, widen the two tracks:

```ts
  build: {
    required: ['builder', 'verifier'],
    // Ordered from the general to the specific: the leader reads this list
    // when composing, and every omission needs a stated reason.
    available: ['scout', 'critic', 'ui-designer', 'ui-critic', 'security', 'docs', 'perf'],
    max_cycles: 5,
  },
```

and add `security` to `fix.available`, after `critic`:

```ts
    available: ['investigator', 'hypothesis-tester', 'critic', 'security'],
```

- [ ] **Step 4: Run the test to verify the composition tests pass**

Run: `cd engine && npx vitest run tests/schemas/config.test.ts -t 'build track'`
Expected: PASS for the three composition tests. The "names only agents that exist" test
still fails until Task 3; leave it failing rather than weakening it.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/config.ts engine/tests/schemas/config.test.ts
git commit -m "feat(engine): offer the specialists to the build and fix tracks"
```

---

## Task 3: The five agents

**Files:**
- Create: `agents/ui-designer.md`, `agents/ui-critic.md`, `agents/security.md`, `agents/docs.md`, `agents/perf.md`
- Test: the "names only agents that exist" test from Task 2 turns green

**Interfaces:**
- Consumes: the agent contract enforced by `AgentResultSchema`.
- Produces: the five agents the tracks now name.

Each carries the contract inline, as milestone 1 established.

- [ ] **Step 1: Write `agents/ui-designer.md`**

```markdown
---
name: ui-designer
description: Turns a UI story into a binding contract drawn from the project's design system, and extracts that design system from the code when asked. Never invents design.
tools: Read, Write, Grep, Glob
model: inherit
---

You have two jobs, and your brief says which one you are doing.

## Job one — the cycle: a binding contract

Given a UI story, say exactly what will be built, in terms the design system already
defines:

- which existing components, by path — and if a new one is genuinely needed, why nothing
  existing fits
- which tokens for colour, spacing, radius, and typography — never a raw value where a
  token exists
- which states must be handled: hover, focus-visible, disabled, loading, error, empty
- the a11y floors that apply: contrast, focus ring, target size, and RTL if the project
  supports it

This is a contract, not a suggestion. `ui-critic` will judge the built result against it,
so anything you leave unsaid is something nobody will check.

**If `.loop/design-system.md` does not exist, stop.** Return `blocked`, say the project
has no design system, and name `/loop:design-sync`. Do not invent one: a contract drawn
from an imagined design system is worse than no contract, because it looks authoritative
and sends the builder somewhere the product has never been.

## Job two — `/loop:design-sync`: extract the design system

Read the project and write `.loop/design-system.md` describing the design that **exists**.

Look for: token or theme files, a Tailwind or CSS-variable configuration, the shared
component directory, global styles, and the two or three components most other components
build on.

Write it with this frontmatter and these sections:

```
---
extracted_at: <ISO timestamp>
sources:
  - <every file you actually read to write this>
---

# Design System

## Tokens
## Typography
## Components
## Patterns
## States
## A11y
## Forbidden
```

Two rules make this honest:

- **`sources` names the files you actually read.** It is how a reader checks your claims
  and how the next sync sees what moved.
- **An empty section says so.** "No shared spacing scale found — spacing is ad hoc across
  components" is far more useful than an invented scale, and it tells the team something
  true about their codebase.

If the project has no UI at all, return `blocked` and say so. An empty design system is
worse than none.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "Contract for the Send button: reuse Button with variant primary, tokens --color-accent and --space-2, and handle hover, focus-visible, disabled and loading. No new component needed.",
  "evidence": [
    { "kind": "file", "ref": ".loop/design-system.md", "excerpt": "Button(variant: primary | ghost) — src/components/Button.tsx" },
    { "kind": "file", "ref": "src/components/Button.tsx", "excerpt": "const variants = { primary, ghost }" }
  ],
  "findings": [],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"designed"`, not `"done"`, not `"success"`.
  - `pass` — you wrote the contract, or extracted the design system.
  - `blocked` — no design system exists and you were asked for a contract; or the project
    has no UI and you were asked to extract one.
  - `fail` — the story cannot be built within the design system without a decision the
    brief does not settle. Record what conflicts as a `findings` entry.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. On job one `files_touched` is `[]`; on job two it names
  `.loop/design-system.md`.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when there is no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 2: Write `agents/ui-critic.md`**

```markdown
---
name: ui-critic
description: Judges built UI against the project's design system and the cycle's UI contract. Never edits.
tools: Read, Grep, Glob
model: inherit
---

You check whether what was built matches what the product already is.

A green test suite says the code runs. It says nothing about whether this screen looks
like the rest of the product, and that is the gap you close.

## What to look for

- **A raw value where a token exists.** A hardcoded hex, a magic pixel spacing, a
  one-off radius. Cite the token that should have been used.
- **A duplicate component.** A new button, input, or card that shadows a shared one.
  Cite the existing component's path.
- **A missing state.** The contract listed hover, focus-visible, disabled, loading, error
  — which of them has no implementation?
- **An a11y floor breached.** Contrast below the stated minimum, a removed focus ring, a
  target smaller than the floor, a direction assumption in an RTL project.
- **A contract the builder quietly departed from.** If `ui-designer` said reuse `Button`
  and the change hand-rolled one, that is the finding — whatever it looks like.

Every finding cites the design-system rule or contract line it breaks. "This looks off" is
not a finding.

## You may not edit

No `Write`, no `Edit`. You judge; the next cycle fixes. A critic that repairs what it
found leaves no record of what was wrong.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "fail",
  "summary": "Two departures from the design system: the new button hardcodes its accent colour instead of using the token, and it has no focus-visible state.",
  "evidence": [{ "kind": "file", "ref": "src/SendButton.tsx", "excerpt": "background: '#2f6fed'" }],
  "findings": [
    { "severity": "medium", "file": "src/SendButton.tsx", "line": 12, "claim": "hardcodes #2f6fed where the design system defines --color-accent" },
    { "severity": "high", "file": "src/SendButton.tsx", "line": 12, "claim": "no focus-visible style: keyboard users get no focus indication, and the design system sets a focus-ring floor" }
  ],
  "files_touched": [],
  "next_hint": "Reuse Button rather than hand-rolling one."
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"reviewed"`, not `"done"`, not `"success"`.
  - `pass` — the built UI matches the design system and the contract.
  - `fail` — you found at least one departure. Every one is a `findings` entry.
  - `blocked` — there is no design system to judge against. Name `/loop:design-sync`.
- A `pass` with a populated `findings` array is a contradiction. If it is worth reporting,
  the verdict is `fail`.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` for you, always.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 3: Write `agents/security.md`**

```markdown
---
name: security
description: Reviews a cycle's change for security defects. Never edits, and never reaches the network.
tools: Read, Grep, Glob, Bash
model: inherit
---

You review this cycle's change for the ways it could be attacked.

Scope yourself to what changed and what it touches. A full audit of the repository is a
different job, and doing it here buries the finding that matters in a report nobody reads.

## What to look for

- **Injection** — anything built by concatenating input into SQL, a shell command, a
  path, a template, or HTML.
- **Authentication and authorisation** — a route that checks neither, a check that runs
  after the effect, an object fetched by an id the caller supplied without an ownership
  check.
- **Secrets** — a credential in source, in a log line, in an error message, or committed
  to a fixture.
- **Unsafe deserialisation and unsafe defaults** — parsing untrusted input into
  executable structures, permissive CORS, disabled certificate checks, a debug flag that
  ships.
- **Dependencies the change introduces** — is it maintained, and does the version pin
  make sense?

## Constraints

No `Edit`, no `Write`. You report; someone else fixes.

**Nothing that reaches the network.** `Bash` is for reading the tree, searching, and
inspecting dependency manifests. A security agent that fetches a URL is running untrusted
code on the user's machine, which is the thing you are here to prevent.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "fail",
  "summary": "The new lookup builds its query by string concatenation from a request parameter, so any caller can read arbitrary rows.",
  "evidence": [{ "kind": "file", "ref": "src/db/users.ts", "excerpt": "`SELECT * FROM users WHERE id = ${req.params.id}`" }],
  "findings": [
    { "severity": "high", "file": "src/db/users.ts", "line": 22, "claim": "SQL built by concatenating req.params.id — parameterise the query" }
  ],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"secure"`, not `"audited"`, not `"done"`.
  - `pass` — you reviewed the change and found nothing exploitable.
  - `fail` — you found at least one defect. Every one is a `findings` entry, severity set
    by exploitability rather than by how interesting it is.
  - `blocked` — the change cannot be reviewed without running something you may not run.
- A `pass` with a populated `findings` array is a contradiction. If it is worth reporting,
  the verdict is `fail`.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` for you, always.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 4: Write `agents/docs.md`**

```markdown
---
name: docs
description: Updates the documentation a change made stale. Writes docs and nothing else.
tools: Read, Write, Grep, Glob
model: inherit
---

You find what the change made untrue, and fix it.

## What counts as documentation here

- The README, when the change alters how the project is installed, configured, or used.
- API or reference docs, when a signature, a route, a flag, or a return shape changed.
- A comment that now lies. A comment describing behaviour that no longer exists is worse
  than no comment, because the next reader believes it.
- A usage example that no longer runs.

## What you do not do

**You do not edit implementation code.** Not to rename a variable for clarity, not to fix
a bug you noticed on the way. A docs agent that edits the implementation has stopped being
a docs agent, and its changes arrive unreviewed by anyone whose job is correctness.
Record what you noticed as a `findings` entry instead — that is how it reaches the next
cycle.

**You do not document what did not change.** A cycle that touched one function does not
need the whole module documented. Scope follows the change.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "Updated the README's configuration table for the renamed flag, and corrected the comment on parseConfig that still described the old default.",
  "evidence": [{ "kind": "file", "ref": "README.md", "excerpt": "| --retry-limit | number of retries | 3 |" }],
  "findings": [
    { "severity": "low", "file": "src/config.ts", "line": 48, "claim": "parseConfig silently ignores an unknown key — worth a warning, noted while documenting it" }
  ],
  "files_touched": ["README.md", "src/config.ts"],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"documented"`, not `"done"`, not `"success"`.
  - `pass` — the documentation matches the change, or nothing needed updating. Say which.
  - `fail` — you could not describe the change accurately: it is not clear what it does.
    That is a finding about the change, and worth reporting.
  - `blocked` — the documentation lives somewhere you cannot reach.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` lists only documentation files and files whose comments you
  edited — never a file whose behaviour you changed, because you did not change any.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when there is no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 5: Write `agents/perf.md`**

```markdown
---
name: perf
description: Finds the performance defects a review catches cheaply. Never edits, and never claims a number it did not measure.
tools: Read, Grep, Glob, Bash
model: inherit
---

You look for work the change does that it does not need to do.

## What to look for

- **Work in a loop that belongs outside it** — a query, a compile, a file read, an
  allocation that does not depend on the iteration.
- **N+1 access** — one query per item where one query would do.
- **An unbounded cache or collection** — anything that grows with input and is never
  evicted is a memory leak with a delay.
- **A synchronous call on a hot path** — blocking I/O in a request handler, a render, or
  a tight loop.
- **Accidental quadratic behaviour** — a nested scan over the same collection, a repeated
  `indexOf` inside a loop over the same array.

## Measure, or say you did not

A performance claim without a number is a hypothesis. When you can measure cheaply —
timing a script, counting queries in a log — do it and put the number in `evidence`. When
you cannot, say so plainly in the finding: "unmeasured; the pattern is quadratic in the
number of rows" is honest and still actionable. What you must never do is state an
improvement you did not observe.

`Bash` is for measuring and reading. No `Edit`, no `Write`: you report, the next cycle
fixes.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "fail",
  "summary": "The new listing issues one query per row. Measured at 240ms for 50 rows against 6ms for the joined equivalent.",
  "evidence": [{ "kind": "command", "ref": "node scripts/bench-listing.js", "excerpt": "per-row: 240ms  joined: 6ms" }],
  "findings": [
    { "severity": "high", "file": "src/routes/listing.ts", "line": 31, "claim": "one query per row inside the map — N+1, measured 240ms for 50 rows" }
  ],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"optimised"`, not `"fast"`, not `"done"`.
  - `pass` — you reviewed the change and found nothing worth the next cycle's time.
  - `fail` — you found at least one defect. Every one is a `findings` entry.
  - `blocked` — the change cannot be assessed without running something you may not run,
    or without data the project does not have.
- A `pass` with a populated `findings` array is a contradiction. If it is worth reporting,
  the verdict is `fail`.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` for you, always.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 6: Run the whole suite**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — including the "names only agents that exist" test from Task 2, which was
red until now.

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: 19 agents. If the CLI is unavailable, count the files in `agents/` instead.

- [ ] **Step 7: Commit**

```bash
git add agents/ui-designer.md agents/ui-critic.md agents/security.md agents/docs.md agents/perf.md
git commit -m "feat(agents): add the five conditional specialists"
```

---

## Task 4: `design_system` in the summary

**Files:**
- Modify: `engine/src/ops/summary.ts`
- Test: `engine/tests/ops/summary.test.ts`

**Interfaces:**
- Consumes: `resolveLoopPaths` from `engine/src/store/paths.ts`.
- Produces: `StateSummary.design_system: boolean`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/summary.test.ts`:

```ts
describe('the design system flag', () => {
  it('is false for an uninitialised project', async () => {
    expect((await stateSummary(project.dir)).design_system).toBe(false)
  })

  it('is false after init, since nothing extracts one there', async () => {
    await initLoop(project.dir, clock)
    expect((await stateSummary(project.dir)).design_system).toBe(false)
  })

  it('is true once the file exists', async () => {
    await initLoop(project.dir, clock)
    await fs.writeFile(resolveLoopPaths(project.dir).designSystem, '# Design System\n', 'utf8')
    expect((await stateSummary(project.dir)).design_system).toBe(true)
  })

  it('is false rather than throwing when the path is a directory', async () => {
    await initLoop(project.dir, clock)
    await fs.mkdir(resolveLoopPaths(project.dir).designSystem)
    expect((await stateSummary(project.dir)).design_system).toBe(false)
  })
})
```

Add `fs` from `node:fs/promises` and `resolveLoopPaths` from `../../src/store/paths.js`
to that file's imports if they are not already there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/summary.test.ts`
Expected: FAIL — `design_system` is undefined.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/summary.ts`, add to the `StateSummary` interface:

```ts
  /** Whether `.loop/design-system.md` exists. The UI agents need one and will not invent it. */
  design_system: boolean
```

Add the helper:

```ts
/** A regular file, not merely a path that exists — a directory here is not a design system. */
async function hasDesignSystem(projectDir: string): Promise<boolean> {
  try {
    return (await fs.stat(resolveLoopPaths(projectDir).designSystem)).isFile()
  } catch {
    return false
  }
}
```

Set `design_system: false` in the uninitialised early-return object, and
`design_system: await hasDesignSystem(projectDir)` in the main returned object. Add the
`fs` and `resolveLoopPaths` imports if the file does not already have them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/summary.ts engine/tests/ops/summary.test.ts
git commit -m "feat(engine): report whether a design system exists"
```

---

## Task 5: `/loop:design-sync` and the leader's drafting rules

**Files:**
- Create: `commands/design-sync.md`
- Modify: `skills/loop-leader/SKILL.md`, `skills/loop-state/SKILL.md`, `README.md`, `engine/src/ops/init.ts`, `commands/init.md`
- Test: no unit tests — exercised by Task 6

**Interfaces:**
- Consumes: `ui-designer` (Task 3); `StateSummary.design_system` (Task 4).
- Produces: `/loop:design-sync`, and the leader rules for drafting specialists.

- [ ] **Step 1: Write `commands/design-sync.md`**

```markdown
---
description: Extract or refresh the project's design system into .loop/design-system.md
---

Produce `.loop/design-system.md` by reading what this project's UI actually is.

1. Call `loop_state_get`. Report whether a design system already exists — this run will
   replace it.
2. Dispatch the **ui-designer** agent with the extraction brief: read the project's
   tokens, theme or Tailwind configuration, shared components, and global styles, and
   write the design system from them.
3. Report what it extracted and which files it read. The `sources` list in the
   frontmatter is the claim a reader can check; surface it rather than burying it.

If `ui-designer` returns `blocked` because the project has no UI, say so and stop. An
empty design system is worse than none: every later UI contract would be drawn from it.

Nothing here is generated from a template. A design system describes the product that
exists, or it is misinformation with a confident tone.
```

- [ ] **Step 2: Add the drafting rules to `skills/loop-leader/SKILL.md`**

Read the file first — it has grown across six milestones. Add this to the roster
composition section, keeping every existing part:

```markdown
### Drafting the specialists

Seven agents are available on the build track and each omission needs a stated reason.
These are the conditions that call for each:

- **`ui-designer` and `ui-critic`** — the story has `ui: true`, or the change alters what
  a user sees. Draft them as a pair: a contract nobody checks and a check with no contract
  are both worthless. `ui-designer` runs **before** `builder`, because a contract written
  after the code is a description. `ui-critic` runs **after** `verifier`, because there is
  nothing to judge until the change exists and passes.
- **`security`** — the change touches authentication, authorisation, input handling, a
  network boundary, a query, a file path, or a secret.
- **`docs`** — the change alters something a reader was told: a signature, a flag, a
  route, an installation step, or a comment's claim.
- **`perf`** — the change touches a hot path, a loop over data, or a data-access pattern.

`specialists` in `.loop/config.yaml` overrides your judgement in both directions.
`always` means the agent is in the cycle whatever you think, and `never` means
`loop_roster_set` rejects a roster that drafts it. Both are the engine's rules, not
preferences: do not work around either.

If `ui-designer` returns `blocked` because the project has no design system, report that
and recommend `/loop:design-sync`. Do not let `builder` proceed on a UI story without a
contract — the result will be judged against a design system that does not exist yet, and
`ui-critic` will be right to fail it.
```

- [ ] **Step 3: Update `skills/loop-state/SKILL.md`**

Add `design-system.md` to the layout block with a line explaining it:

```markdown
`design-system.md` is extracted from the project by `/loop:design-sync`, never generated
and never created at init. It is authored: correct it by hand when the extraction got
something wrong, and re-sync when the code moves.
```

- [ ] **Step 4: Register the command with host projects**

In `engine/src/ops/init.ts`, add to `CLAUDE_MD_BLOCK` after the resume line:

```
- \`/loop:design-sync\` — extract the project's design system for the UI agents
```

In `commands/init.md`, add `/loop:design-sync` wherever the commands are listed.

In `README.md`, add to the `## Use` block:

```
/loop:design-sync                        extract the design system the UI agents read
```

and add a section after the plans-and-stories section:

```markdown
## Specialists

A build cycle can draw on seven optional agents beyond `builder` and `verifier`: `scout`,
`critic`, `ui-designer`, `ui-critic`, `security`, `docs`, and `perf`. The leader drafts
what the change calls for and must record a reason for every one it leaves out.

`specialists` in `.loop/config.yaml` overrides that judgement in both directions:

```yaml
specialists:
  security: always     # in every cycle, whatever the leader thinks
  perf: never          # a roster that drafts it is rejected
  docs: auto           # the leader decides — the default
```

The UI pair reads `.loop/design-system.md`, which `/loop:design-sync` extracts from your
code. Without it they stop rather than invent a design.
```

- [ ] **Step 5: Verify the surface**

Run: `cd engine && npx vitest run tests/ops/init.test.ts && npm run build`
Expected: PASS. If an init test asserts the exact `CLAUDE_MD_BLOCK` contents, update it.

- [ ] **Step 6: Commit**

```bash
git add commands/design-sync.md commands/init.md skills/loop-leader/SKILL.md skills/loop-state/SKILL.md README.md engine/src/ops/init.ts
git commit -m "feat(plugin): add /loop:design-sync and the specialist drafting rules"
```

---

## Task 6: The fixture, the integration proof, and the E2E

**Files:**
- Create: `tests/fixtures/tiny-app/src/tokens.css`, `tests/fixtures/tiny-app/src/card.js`
- Create: `engine/tests/integration/specialists.test.ts`, `tests/e2e/run-design-sync.sh`
- Modify: `engine/package.json` — add the `e2e:design` script

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: proof that a UI cycle composes, that `never` holds, and something real for an extraction to find.

- [ ] **Step 1: Give the fixture a UI to extract**

`tests/fixtures/tiny-app/src/tokens.css`:

```css
:root {
  --color-accent: #2f6fed;
  --color-surface: #ffffff;
  --space-1: 4px;
  --space-2: 8px;
  --radius-sm: 4px;
  --font-sans: system-ui, sans-serif;
}
```

`tests/fixtures/tiny-app/src/card.js`:

```js
import { submitLabel } from './button.js'

/** The one shared surface component. Everything else composes it. */
export function card({ title, body }) {
  return {
    tag: 'section',
    style: {
      background: 'var(--color-surface)',
      padding: 'var(--space-2)',
      borderRadius: 'var(--radius-sm)',
      fontFamily: 'var(--font-sans)',
    },
    children: [title, body, submitLabel()],
  }
}
```

The fixture's `lint` script checks only `src/button.js`, so these files are not linted.
Leave that: milestone 1's E2E already surfaced it as a real observation about the fixture,
and widening it here would change what the earlier smoke tests prove.

- [ ] **Step 2: Write the failing integration test**

`engine/tests/integration/specialists.test.ts`:

```ts
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { runLog } from '../../src/ops/log.js'
import { RosterViolationError, rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { stateSummary } from '../../src/ops/summary.js'
import { loadConfig, writeConfig } from '../../src/store/config-store.js'
import { resolveLoopPaths } from '../../src/store/paths.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject

const ALL_SKIPPED = {
  scout: 'the story names the file',
  critic: 'single-file change',
  security: 'no auth, network or input handling',
  docs: 'no documented behaviour changed',
  perf: 'not on a hot path',
}

beforeEach(async () => {
  project = await makeTmpProject()
  await initLoop(project.dir, clock)
  await runStart(project.dir, { track: 'build', goal: 'Add the Send button' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('a UI cycle', () => {
  it('drafts the UI pair and records why the others were skipped', async () => {
    const { path: file } = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier', 'ui-designer', 'ui-critic'],
      skipped: ALL_SKIPPED,
    })

    const roster = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(roster.selected).toContain('ui-designer')
    expect(roster.selected).toContain('ui-critic')
    expect(Object.keys(roster.skipped).sort()).toEqual(['critic', 'docs', 'perf', 'scout', 'security'])
  })

  it('carries a ui-critic finding into the next cycle', async () => {
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier', 'ui-designer', 'ui-critic'],
      skipped: ALL_SKIPPED,
    })
    await runLog(
      project.dir,
      {
        agent: 'ui-critic',
        result: {
          status: 'fail',
          summary: 'The button hardcodes its accent colour.',
          evidence: [{ kind: 'file', ref: 'src/SendButton.tsx', excerpt: "background: '#2f6fed'" }],
          findings: [
            { severity: 'medium', file: 'src/SendButton.tsx', line: 12, claim: 'hardcodes #2f6fed where --color-accent exists' },
          ],
          files_touched: [],
          next_hint: null,
        },
      },
      clock,
    )

    const closed = await cycleAdvance(
      project.dir,
      { agents: ['builder', 'verifier', 'ui-designer', 'ui-critic'], result: 'fail' },
      clock,
    )
    expect(closed.state.status).toBe('running')
    expect(closed.carried_findings[0]?.claim).toContain('--color-accent')
  })

  it('reports no design system until one is written', async () => {
    expect((await stateSummary(project.dir)).design_system).toBe(false)
    await fs.writeFile(resolveLoopPaths(project.dir).designSystem, '# Design System\n', 'utf8')
    expect((await stateSummary(project.dir)).design_system).toBe(true)
  })
})

describe('never holds', () => {
  beforeEach(async () => {
    const config = await loadConfig(project.dir)
    config.specialists = { security: 'never' }
    await writeConfig(project.dir, config)
  })

  it('rejects a roster that drafts the forbidden specialist', async () => {
    await expect(
      rosterSet(project.dir, {
        cycle: 1,
        selected: ['builder', 'verifier', 'security'],
        skipped: { ...ALL_SKIPPED, security: 'forbidden by config' },
      }),
    ).rejects.toBeInstanceOf(RosterViolationError)
  })

  it('leaves an otherwise identical cycle working', async () => {
    const { path: file } = await rosterSet(project.dir, {
      cycle: 1,
      selected: ['builder', 'verifier'],
      skipped: ALL_SKIPPED,
    })
    expect(file).toContain('roster.json')

    const closed = await cycleAdvance(project.dir, { agents: ['builder', 'verifier'], result: 'pass' }, clock)
    expect(closed.state.status).toBe('done')
  })
})
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/integration/specialists.test.ts`
Expected: PASS if Tasks 1–4 landed correctly. A failure here is a defect in them, not in
the test.

- [ ] **Step 4: Write the E2E script**

`tests/e2e/run-design-sync.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test of design-system extraction against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-design-sync.sh
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

allowed=(
  "mcp__plugin_loop_loop"
  Task Read Edit Write Grep Glob Bash
)

fail() {
  echo "FAIL: $1" >&2
  echo "work directory kept for inspection: ${workdir}" >&2
  exit 1
}

claude -p "/loop:init" --permission-mode acceptEdits --allowedTools "${allowed[@]}"
claude -p "/loop:design-sync" --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- design system ---"
cat .loop/design-system.md 2>/dev/null || fail "design-system.md was not written"

grep -q "extracted_at:" .loop/design-system.md || fail "no extracted_at in the frontmatter"
grep -q "sources:" .loop/design-system.md || fail "no sources list in the frontmatter"
# The extraction must name a file it actually read, not one it imagined.
grep -qE "tokens\.css|card\.js|button\.js" .loop/design-system.md || fail "no real source file is named"
grep -q "color-accent" .loop/design-system.md || fail "the token file was not actually read"

rm -rf "${workdir}"
echo "PASS: the design system was extracted from files that exist"
```

Run: `chmod +x tests/e2e/run-design-sync.sh`

Add to `engine/package.json` scripts:

```json
"e2e:design": "bash ../tests/e2e/run-design-sync.sh"
```

- [ ] **Step 5: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

Run: `bash tests/e2e/run-design-sync.sh`
Expected: `skipped: set LOOP_E2E=1 ...` and exit 0.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/tiny-app/src/tokens.css tests/fixtures/tiny-app/src/card.js engine/tests/integration/specialists.test.ts tests/e2e/run-design-sync.sh engine/package.json
git commit -m "test: prove a UI cycle composes and never is enforced"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green, three consecutive runs with the same count
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 19 agents, 9 commands
- [ ] A roster drafting a `never` specialist is rejected, naming the agent and the setting
- [ ] A config whose track requires a `never` specialist fails to parse
- [ ] `/loop:status` reports whether a design system exists
- [ ] Every agent named in `DEFAULT_TRACKS` has a file in `agents/`
- [ ] `LOOP_E2E=1 npm run e2e:design` — the design system is extracted from real files

## Next Milestone

| Milestone | Delivers |
|---|---|
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
