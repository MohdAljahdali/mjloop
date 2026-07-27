# Loop — Milestone 4b: The Plan Track — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/loop:plan <idea>` — the fourth and last track — so an idea becomes a criticised, fit-checked, human-approved plan broken into stories that `/loop:build --next` can consume.

**Architecture:** Two gates of different kinds guard the track. The fit-check gate is milestone 3's evidence gate reused with no change. The approval gate is a decision recorded on the plan by `loop_gate_set` and enforced at `storyAdd`, because a human's decision has no evidence beyond having been made. Agents that author prose write their own files, so `readPlan` gains frontmatter repair from the directory name.

**Tech Stack:** TypeScript 5 · Node 24 (floor 20) · zod 4.4.3 · yaml 2.9.0 · @modelcontextprotocol/sdk 1.29.0 · vitest 4.1.10

**Spec:** `docs/superpowers/specs/2026-07-27-loop-milestone-4b-plan-track-design.md`

## Global Constraints

- All plugin files, prompts, code, comments, and documentation in **English**. Conversation with the user is Arabic; nothing in the repository is.
- **zod 4 idioms only:** `z.strictObject(...)` not `z.object(...).strict()`; `z.iso.datetime()` not `z.string().datetime()`; `z.record(keySchema, valueSchema)` requires both arguments; format errors with `z.prettifyError(error)`.
- **State has one owner.** Nothing outside `engine/src/store` and `engine/src/ops` may write `.loop/state.json` or any `manifest.json`.
- **The manifest is derived.** Never patch it; regenerate it whole from the story files.
- **The engine does not know agent names.** Any rule naming a specific agent belongs in track config.
- **Any string that reaches the filesystem is validated** before it is interpolated into a path.
- Every operation that stamps a timestamp takes an injectable `now: Clock` defaulting to `() => new Date()`.
- Every task ends with a commit. Tests must be seen failing before the implementation is written.

---

## File Structure

| File | Responsibility |
|---|---|
| `engine/src/schemas/plan.ts` | `ApprovalSchema`, `PlanFrontmatterSchema.approval` |
| `engine/src/schemas/config.ts` | `DEFAULT_TRACKS.plan` with the fit-check gate |
| `engine/src/store/plan-store.ts` | Frontmatter repair in `readPlan` |
| `engine/src/ops/plan.ts` | `gateSet`; `storyAdd` refuses an unapproved plan |
| `engine/src/ops/index-render.ts` | An `Approved` column |
| `engine/src/mcp/server.ts` | `loop_gate_set` |
| `agents/planner.md`, `plan-critic.md`, `fit-checker.md`, `story-writer.md`, `story-critic.md` | **New.** Five plan-track agents |
| `commands/plan.md` | **New.** `/loop:plan <idea>` |
| `skills/loop-leader/SKILL.md` | Plan-track ordering, approval, verifier-free verdict |
| `engine/tests/integration/plan-track.test.ts` | **New.** Idea to stories, and both gates holding |
| `tests/e2e/run-plan.sh` | **New.** Opt-in real-CLI smoke test |

---

## Task 1: The approval schema and the `plan` track

**Files:**
- Modify: `engine/src/schemas/plan.ts`, `engine/src/schemas/config.ts`
- Test: `engine/tests/schemas/plan.test.ts`, `engine/tests/schemas/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ApprovalDecisionSchema`, `ApprovalSchema`, types `ApprovalDecision` and `Approval`; `PlanFrontmatterSchema.approval: Approval | null`; `DEFAULT_TRACKS.plan`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/schemas/plan.test.ts`, inside `describe('PlanFrontmatterSchema', ...)`:

```ts
  it('defaults approval to null on a plan written before the field existed', () => {
    const plan = { id: 'P001', slug: 'user-auth', title: 'User authentication', created_at: '2026-07-27T09:00:00.000Z' }
    expect(PlanFrontmatterSchema.parse(plan).approval).toBeNull()
  })

  it('accepts a recorded approval', () => {
    const plan = {
      id: 'P001',
      slug: 'user-auth',
      title: 'User authentication',
      created_at: '2026-07-27T09:00:00.000Z',
      approval: {
        decision: 'approved',
        by: 'mohd',
        at: '2026-07-27T11:20:00.000Z',
        note: 'Ship it, but keep the token TTL configurable.',
      },
    }
    expect(PlanFrontmatterSchema.safeParse(plan).success).toBe(true)
  })

  it('accepts an approval with no note', () => {
    const approval = { decision: 'rejected', by: 'mohd', at: '2026-07-27T11:20:00.000Z' }
    expect(ApprovalSchema.parse(approval).note).toBeNull()
  })

  it('rejects a decision outside the three values', () => {
    const approval = { decision: 'maybe', by: 'mohd', at: '2026-07-27T11:20:00.000Z' }
    expect(ApprovalSchema.safeParse(approval).success).toBe(false)
  })

  it('rejects an approval with no approver', () => {
    const approval = { decision: 'approved', by: '', at: '2026-07-27T11:20:00.000Z' }
    expect(ApprovalSchema.safeParse(approval).success).toBe(false)
  })
```

Add `ApprovalSchema` to that file's imports.

Add to `engine/tests/schemas/config.test.ts`, inside `describe('DEFAULT_TRACKS', ...)`:

```ts
  it('gates the plan track on the fit-checker and blocks the story-writer', () => {
    expect(DEFAULT_TRACKS.plan).toEqual({
      required: ['planner', 'fit-checker', 'story-writer'],
      available: ['plan-critic', 'story-critic'],
      max_cycles: 6,
      gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
    })
  })
```

And update the key-order assertion in `describe('defaultConfig', ...)`:

```ts
    expect(Object.keys(config.tracks)).toEqual(['edit', 'build', 'fix', 'plan'])
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/schemas/`
Expected: FAIL — `ApprovalSchema` is not exported, `approval` is an unknown key, `DEFAULT_TRACKS.plan` is undefined.

- [ ] **Step 3: Write the implementation**

In `engine/src/schemas/plan.ts`, add above `PlanFrontmatterSchema`:

```ts
export const ApprovalDecisionSchema = z.enum(['approved', 'rejected', 'changes_requested'])

/**
 * A decision, not a demonstrated fact. That is why a tool records it, where
 * milestones 2 and 3 refused tools that would have taken the leader's word for
 * a finding being resolved or a defect being reproduced: those had an
 * underlying fact that evidence could establish, and an approval does not.
 *
 * `rejected` and `changes_requested` are recorded too. A plan that was seen and
 * turned down is in a different state from one nobody has looked at.
 */
export const ApprovalSchema = z.strictObject({
  decision: ApprovalDecisionSchema,
  /** Who decided. Free text: the engine cannot verify it, and pretending otherwise would be worse. */
  by: z.string().min(1),
  at: z.iso.datetime(),
  /** The approver's own words, kept so the approval is auditable rather than a bare flag. */
  note: z.string().min(1).nullable().default(null),
})
```

Add the field to `PlanFrontmatterSchema`, after `created_at`:

```ts
  /**
   * The default is load-bearing, as it was for `last_fingerprint` and
   * `reproduction`: the schema is strict, so without it every PLAN.md written
   * before this field existed would fail validation on read.
   */
  approval: ApprovalSchema.nullable().default(null),
```

Add the type exports:

```ts
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>
export type Approval = z.infer<typeof ApprovalSchema>
```

In `engine/src/schemas/config.ts`, extend `DEFAULT_TRACKS`:

```ts
  plan: {
    required: ['planner', 'fit-checker', 'story-writer'],
    available: ['plan-critic', 'story-critic'],
    max_cycles: 6,
    // An evidence gate: whether a plan fits the project that exists is a fact,
    // and fit-checker demonstrates it. The approval gate is a different kind
    // and lives on the plan, not here.
    gate: { proven_by: 'fit-checker', blocks: ['story-writer'] },
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green.

- [ ] **Step 5: Commit**

```bash
git add engine/src/schemas/plan.ts engine/src/schemas/config.ts engine/tests/schemas
git commit -m "feat(engine): add plan approval to the schema and the plan track"
```

---

## Task 2: Frontmatter repair

**Files:**
- Modify: `engine/src/store/plan-store.ts`
- Test: `engine/tests/store/plan-store.test.ts`

**Interfaces:**
- Consumes: `PlanFrontmatterSchema` (Task 1); `parseFrontmatter`, `serialiseFrontmatter`.
- Produces: `Plan.repaired: boolean`; `readPlan` rebuilds a missing or invalid `PLAN.md` frontmatter from the directory name.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/store/plan-store.test.ts`:

```ts
describe('frontmatter repair', () => {
  beforeEach(async () => {
    await writePlan(project.dir, PLAN)
  })

  it('returns a sound plan untouched and does not rewrite it', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    const before = await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(false)
    expect(await fs.readFile(path.join(dir, 'PLAN.md'), 'utf8')).toBe(before)
  })

  it('rebuilds id and slug from the directory name when the frontmatter is gone', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'Just prose, no frontmatter.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P001')
    expect(read.frontmatter.slug).toBe('user-auth')
    expect(read.body).toBe('Just prose, no frontmatter.')
  })

  it('rebuilds from an unparseable frontmatter block', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), '---\nid: [unclosed\n---\n\nThe body survives.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P001')
    expect(read.body).toBe('The body survives.')
  })

  it('rebuilds when a required field was dropped', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), '---\nid: P001\n---\n\nBody.\n', 'utf8')

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.slug).toBe('user-auth')
  })

  it('persists the repair so the next read is clean', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'No frontmatter.\n', 'utf8')

    await readPlan(project.dir, 'P001')
    expect((await readPlan(project.dir, 'P001')).repaired).toBe(false)
  })

  it('recovers the title from the manifest when one exists', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        schema: 1,
        plan: 'P001',
        slug: 'user-auth',
        title: 'User authentication',
        generated_at: '2026-07-27T09:14:00.000Z',
        stories: [],
      }),
      'utf8',
    )
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'No frontmatter.\n', 'utf8')

    expect((await readPlan(project.dir, 'P001')).frontmatter.title).toBe('User authentication')
  })

  it('falls back to the slug for a title when there is no manifest', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.rm(path.join(dir, 'manifest.json'), { force: true })
    await fs.writeFile(path.join(dir, 'PLAN.md'), 'No frontmatter.\n', 'utf8')

    expect((await readPlan(project.dir, 'P001')).frontmatter.title).toBe('user-auth')
  })

  it('rebuilds a PLAN.md that is missing entirely', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    await fs.rm(path.join(dir, 'PLAN.md'))

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(true)
    expect(read.frontmatter.id).toBe('P001')
    expect(read.body).toBe('')
  })

  it('preserves a recorded approval through an unrelated read', async () => {
    const dir = await findPlanDir(project.dir, 'P001')
    const approved = {
      ...PLAN.frontmatter,
      approval: { decision: 'approved', by: 'mohd', at: '2026-07-27T11:20:00.000Z', note: null },
    }
    await writePlan(project.dir, { frontmatter: approved, body: 'Body.' })

    const read = await readPlan(project.dir, 'P001')
    expect(read.repaired).toBe(false)
    expect(read.frontmatter.approval?.decision).toBe('approved')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/store/plan-store.test.ts`
Expected: FAIL — `repaired` is undefined and an invalid `PLAN.md` throws instead of being rebuilt.

- [ ] **Step 3: Write the implementation**

In `engine/src/store/plan-store.ts`, add `repaired` to the `Plan` interface:

```ts
export interface Plan {
  frontmatter: PlanFrontmatter
  body: string
  /** Absolute path to the plan directory. */
  dir: string
  /** True when PLAN.md's frontmatter was missing or invalid and was rebuilt. */
  repaired: boolean
}
```

Replace `readPlan`:

```ts
/**
 * Read a plan, rebuilding its frontmatter if an agent clobbered it.
 *
 * `planner` writes prose into PLAN.md, so the frontmatter the engine depends on
 * is reachable by an agent's `Write`. Failing loudly would let one careless
 * write brick a directory that still holds every story — and repair is cheap
 * here precisely because the identifying facts were never stored in only one
 * place: the directory is named `<id>-<slug>`.
 */
export async function readPlan(projectDir: string, planId: string): Promise<Plan> {
  const dir = await findPlanDir(projectDir, planId)
  const file = path.join(dir, 'PLAN.md')

  let raw = ''
  let missing = false
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    missing = true
  }

  if (!missing) {
    try {
      const { data, body } = parseFrontmatter(raw)
      const parsed = PlanFrontmatterSchema.safeParse(data)
      if (parsed.success) return { frontmatter: parsed.data, body, dir, repaired: false }
    } catch {
      // Fall through to repair: an unparseable block is a clobbered block.
    }
  }

  const body = missing ? '' : recoverBody(raw)
  const frontmatter = await rebuildFrontmatter(dir, planId)
  await fs.writeFile(file, serialiseFrontmatter(frontmatter, body), 'utf8')
  return { frontmatter, body, dir, repaired: true }
}

/** Everything after a frontmatter block, or the whole file when there is none. */
function recoverBody(raw: string): string {
  const closed = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  return (closed?.[1] ?? raw).trim()
}

async function rebuildFrontmatter(dir: string, planId: string): Promise<PlanFrontmatter> {
  const basename = path.basename(dir)
  const slug = basename.slice(planId.length + 1)

  // The manifest is derived from the stories rather than from PLAN.md, so it
  // survives a clobbered PLAN.md and is the best source for the title.
  let title = slug
  let createdAt: string | undefined
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      title?: unknown
      generated_at?: unknown
    }
    if (typeof manifest.title === 'string' && manifest.title.length > 0) title = manifest.title
    if (typeof manifest.generated_at === 'string') createdAt = manifest.generated_at
  } catch {
    // No manifest, or an unreadable one. The slug is a usable title.
  }

  if (createdAt === undefined) {
    // The directory's own timestamp is the best remaining evidence of when
    // this plan came into existence.
    const stats = await fs.stat(dir)
    createdAt = new Date(stats.birthtimeMs || stats.mtimeMs).toISOString()
  }

  const parsed = PlanFrontmatterSchema.safeParse({ id: planId, slug, title, created_at: createdAt })
  if (!parsed.success) {
    throw new InvalidStoryFileError(path.join(dir, 'PLAN.md'), z.prettifyError(parsed.error))
  }
  return parsed.data
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green. Existing callers of `readPlan` destructure
`{ frontmatter, body, dir }` and are unaffected by the added field.

- [ ] **Step 5: Commit**

```bash
git add engine/src/store/plan-store.ts engine/tests/store/plan-store.test.ts
git commit -m "feat(engine): rebuild clobbered plan frontmatter from the directory name"
```

---

## Task 3: `gateSet` and approval enforcement

**Files:**
- Modify: `engine/src/ops/plan.ts`
- Test: `engine/tests/ops/plan.test.ts`

**Interfaces:**
- Consumes: `ApprovalSchema`, `ApprovalDecision` (Task 1); `readPlan`, `writePlan` (Task 2); `loadConfig`.
- Produces: `ApprovalRequiredError`; `gateSet(projectDir, input: { plan: string; decision: ApprovalDecision; by: string; note?: string | null }, now?): Promise<{ plan: string; approval: Approval }>`; `storyAdd` refuses an unapproved plan under `gates.plan_approval: human`.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/ops/plan.test.ts`:

```ts
describe('gateSet', () => {
  beforeEach(async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  })

  it('records the decision, the approver, the time, and their words', async () => {
    const result = await gateSet(
      project.dir,
      { plan: 'P001', decision: 'approved', by: 'mohd', note: 'Ship it.' },
      clock,
    )
    expect(result.approval).toEqual({
      decision: 'approved',
      by: 'mohd',
      at: NOW.toISOString(),
      note: 'Ship it.',
    })
    expect((await readPlan(project.dir, 'P001')).frontmatter.approval?.decision).toBe('approved')
  })

  it('defaults the note to null', async () => {
    const result = await gateSet(project.dir, { plan: 'P001', decision: 'rejected', by: 'mohd' }, clock)
    expect(result.approval.note).toBeNull()
  })

  it('lets a later decision replace an earlier one', async () => {
    await gateSet(project.dir, { plan: 'P001', decision: 'changes_requested', by: 'mohd' }, clock)
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'mohd' }, clock)
    expect((await readPlan(project.dir, 'P001')).frontmatter.approval?.decision).toBe('approved')
  })

  it('leaves the plan body intact', async () => {
    await planCreate(project.dir, { slug: 'billing', title: 'Billing', body: 'The approach.' }, clock)
    await gateSet(project.dir, { plan: 'P002', decision: 'approved', by: 'mohd' }, clock)
    expect((await readPlan(project.dir, 'P002')).body).toBe('The approach.')
  })

  it('throws PlanNotFoundError for a plan that does not exist', async () => {
    await expect(
      gateSet(project.dir, { plan: 'P404', decision: 'approved', by: 'mohd' }, clock),
    ).rejects.toBeInstanceOf(PlanNotFoundError)
  })
})

describe('the approval gate', () => {
  beforeEach(async () => {
    await initLoop(project.dir, clock)
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  })

  it('refuses a story on an unapproved plan when approval is human', async () => {
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )
  })

  it('names the plan and the tool that would open it', async () => {
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toThrow(
      /P001[\s\S]*loop_gate_set/,
    )
  })

  it('writes nothing when it refuses', async () => {
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toThrow()
    const dir = await findPlanDir(project.dir, 'P001')
    expect(await fs.readdir(path.join(dir, 'stories'))).toEqual([])
  })

  it('allows the story once the plan is approved', async () => {
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'mohd' }, clock)
    const added = await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    expect(added.id).toBe('P001-S01')
  })

  it('stays shut for a rejection or a change request', async () => {
    await gateSet(project.dir, { plan: 'P001', decision: 'rejected', by: 'mohd' }, clock)
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )

    await gateSet(project.dir, { plan: 'P001', decision: 'changes_requested', by: 'mohd' }, clock)
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )
  })

  it('does not gate anything when approval is auto', async () => {
    const config = await loadConfig(project.dir)
    config.gates.plan_approval = 'auto'
    await writeConfig(project.dir, config)

    const added = await storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)
    expect(added.id).toBe('P001-S01')
  })
})
```

Add to that file's imports: `gateSet`, `ApprovalRequiredError` from `../../src/ops/plan.js`;
`readPlan`, `findPlanDir`, `PlanNotFoundError` from `../../src/store/plan-store.js`;
`initLoop` from `../../src/ops/init.js`; `loadConfig`, `writeConfig` from
`../../src/store/config-store.js`; and `fs`, `path` from node.

Note the existing `planCreate` tests run without `initLoop`, so `loadConfig` must not be
required for them — see the implementation note in Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/plan.test.ts`
Expected: FAIL — `gateSet` is not exported and `storyAdd` gates nothing.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/plan.ts`, add the error and the operation:

```ts
export class ApprovalRequiredError extends Error {
  constructor(planId: string) {
    super(
      `plan "${planId}" has no recorded approval and gates.plan_approval is "human", so no story may be added ` +
        'to it yet. Show the plan to the user, ask whether it is approved, and record their answer with ' +
        'loop_gate_set — including their own words. Never record an approval nobody gave; set ' +
        'gates.plan_approval to "auto" in .loop/config.yaml if this project does not want a human in the loop.',
    )
    this.name = 'ApprovalRequiredError'
  }
}

export interface GateSetInput {
  plan: string
  decision: ApprovalDecision
  by: string
  note?: string | null
}

/**
 * Record a decision about a plan.
 *
 * A tool is the right shape here where milestones 2 and 3 refused one: those
 * would have taken the leader's word for a fact that evidence could establish,
 * and an approval has no fact underneath it — the record is the thing. What the
 * engine cannot do is verify a human made the decision, so it records `by` and
 * the approver's own words instead of pretending to.
 */
export async function gateSet(
  projectDir: string,
  input: GateSetInput,
  now: Clock = () => new Date(),
): Promise<{ plan: string; approval: Approval }> {
  const paths = resolveLoopPaths(projectDir)
  await findPlanDir(projectDir, input.plan)

  return withLock(paths.lock, async () => {
    const plan = await readPlan(projectDir, input.plan)
    const approval = ApprovalSchema.safeParse({
      decision: input.decision,
      by: input.by,
      at: now().toISOString(),
      note: input.note ?? null,
    })
    if (!approval.success) throw new InvalidPlanInputError(z.prettifyError(approval.error))

    await writePlan(projectDir, {
      frontmatter: { ...plan.frontmatter, approval: approval.data },
      body: plan.body,
    })
    return { plan: input.plan, approval: approval.data }
  })
}
```

In `storyAdd`, after the existing `await findPlanDir(projectDir, input.plan)` and before
the lock, add the gate:

```ts
  // The approval gate. A project with no .loop/config.yaml has not opted into
  // anything, so an unreadable config gates nothing — the same degradation
  // stateSummary already applies to a config a user hand-edited badly.
  let requiresApproval = false
  try {
    requiresApproval = (await loadConfig(projectDir)).gates.plan_approval === 'human'
  } catch {
    requiresApproval = false
  }
  if (requiresApproval) {
    const plan = await readPlan(projectDir, input.plan)
    if (plan.frontmatter.approval?.decision !== 'approved') throw new ApprovalRequiredError(input.plan)
  }
```

Add to the file's imports: `ApprovalSchema`, `type Approval`, `type ApprovalDecision` from
`../schemas/plan.js`; `readPlan`, `writePlan` from `../store/plan-store.js`; and
`loadConfig` from `../store/config-store.js`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd engine && npx vitest run && npm run typecheck`
Expected: PASS — every suite green. The existing `storyAdd` tests run on projects created
by `planCreate` without `initLoop`, so `loadConfig` throws `ConfigMissingError` there and
the gate degrades to open, exactly as the comment describes.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/plan.ts engine/tests/ops/plan.test.ts
git commit -m "feat(engine): record plan approvals and gate story creation on them"
```

---

## Task 4: The `Approved` column and the `loop_gate_set` tool

**Files:**
- Modify: `engine/src/ops/index-render.ts`, `engine/src/mcp/server.ts`
- Test: `engine/tests/ops/index-render.test.ts`, `engine/tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `gateSet` (Task 3); `readPlan` (Task 2).
- Produces: an `Approved` column in `INDEX.md`; the `loop_gate_set` MCP tool.

- [ ] **Step 1: Write the failing tests**

Add to `engine/tests/ops/index-render.test.ts`:

```ts
describe('the approved column', () => {
  it('shows no for a plan nobody has decided on', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    expect(await renderIndex(project.dir, clock)).toContain('| P001 | User authentication | 0 | 0 | planned | no |')
  })

  it('shows yes once the plan is approved', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'mohd' }, clock)
    expect(await renderIndex(project.dir, clock)).toContain('| planned | yes |')
  })

  it('distinguishes a change request from never having been reviewed', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await gateSet(project.dir, { plan: 'P001', decision: 'changes_requested', by: 'mohd' }, clock)
    expect(await renderIndex(project.dir, clock)).toContain('changes requested')
  })

  it('shows rejected plainly', async () => {
    await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
    await gateSet(project.dir, { plan: 'P001', decision: 'rejected', by: 'mohd' }, clock)
    expect(await renderIndex(project.dir, clock)).toContain('| rejected |')
  })
})
```

Add `gateSet` to that file's imports.

Add to `engine/tests/mcp/server.test.ts`, extending the tool-list assertion with
`'loop_gate_set'` in sorted position, and adding:

```ts
  it('records an approval and then allows a story', async () => {
    await client.callTool({ name: 'loop_init', arguments: { project_dir: project.dir } })
    await client.callTool({
      name: 'loop_plan_create',
      arguments: { project_dir: project.dir, slug: 'user-auth', title: 'User authentication' },
    })

    const refused = await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form' },
    })
    expect((refused as { isError?: boolean }).isError).toBe(true)
    expect(textOf(refused)).toContain('loop_gate_set')

    await client.callTool({
      name: 'loop_gate_set',
      arguments: { project_dir: project.dir, plan: 'P001', decision: 'approved', by: 'mohd', note: 'Ship it.' },
    })

    const added = await client.callTool({
      name: 'loop_story_add',
      arguments: { project_dir: project.dir, plan: 'P001', title: 'Login form' },
    })
    expect((added as { isError?: boolean }).isError).not.toBe(true)
    expect(JSON.parse(textOf(added)).id).toBe('P001-S01')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && npx vitest run tests/ops/index-render.test.ts tests/mcp/server.test.ts`
Expected: FAIL — the index has five columns and `loop_gate_set` is not registered.

- [ ] **Step 3: Write the implementation**

In `engine/src/ops/index-render.ts`, add the import and the renderer:

```ts
import { listPlanIds, readPlan } from '../store/plan-store.js'
```

```ts
/** Approval is a plan-level fact, so it is read from the plan rather than the manifest. */
function approvalCell(decision: string | undefined): string {
  if (decision === 'approved') return 'yes'
  if (decision === 'rejected') return 'rejected'
  if (decision === 'changes_requested') return 'changes requested'
  return 'no'
}
```

Widen the header and each row inside `renderIndex`. Replace the row push and the header
lines with:

```ts
      const manifest = await renderManifest(projectDir, planId, now)
      const plan = await readPlan(projectDir, planId)
      const done = manifest.stories.filter((story) => story.status === 'done').length
      rows.push(
        `| ${manifest.plan} | ${manifest.title} | ${manifest.stories.length} | ${done} | ${planStatus(manifest.stories)} | ${approvalCell(plan.frontmatter.approval?.decision)} |`,
      )
```

```ts
      '| Plan | Title | Stories | Done | Status | Approved |',
      '|------|-------|---------|------|--------|----------|',
```

In `engine/src/mcp/server.ts`, add the import and register the tool:

```ts
import { gateSet } from '../ops/plan.js'
import { ApprovalDecisionSchema } from '../schemas/plan.js'
```

```ts
  server.registerTool(
    'loop_gate_set',
    {
      title: 'Record a decision about a plan',
      description:
        'Record a plan approval decision. Under gates.plan_approval: human this is what lets stories be added — ask the user and record their answer, including their own words in note. Never record an approval nobody gave.',
      inputSchema: {
        project_dir: projectDirArg,
        plan: z.string().min(1).describe('Plan id, e.g. P001'),
        decision: ApprovalDecisionSchema,
        by: z.string().min(1).describe('Who decided. Use the user name or identifier, not the agent'),
        note: z.string().min(1).nullish().describe("The approver's own words"),
      },
    },
    async ({ project_dir, plan, decision, by, note }) =>
      guard(async () =>
        ok(
          await gateSet(resolveProjectDir(project_dir), {
            plan,
            decision,
            by,
            ...(note === undefined ? {} : { note }),
          }),
        ),
      ),
  )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && npx vitest run && npm run typecheck && npm run build`
Expected: PASS — every suite green, `dist/` rebuilt.

- [ ] **Step 5: Commit**

```bash
git add engine/src/ops/index-render.ts engine/src/mcp/server.ts engine/tests
git commit -m "feat(mcp): expose loop_gate_set and show approval in the index"
```

---

## Task 5: The five plan-track agents

**Files:**
- Create: `agents/planner.md`, `agents/plan-critic.md`, `agents/fit-checker.md`, `agents/story-writer.md`, `agents/story-critic.md`
- Test: no unit tests — markdown assets are exercised by Task 7

**Interfaces:**
- Consumes: the agent contract enforced by `AgentResultSchema`; `loop_story_add`.
- Produces: the five agents named in the `plan` track.

Each carries the contract inline, as milestone 1 established. The shared block below is
repeated verbatim in every file — an agent reads only its own file.

- [ ] **Step 1: Write `agents/planner.md`**

```markdown
---
name: planner
description: Drafts a plan from an idea. Writes PLAN.md prose and never touches its frontmatter. Use for the loop plan track.
tools: Read, Write, Grep, Glob
model: inherit
---

You turn an idea into a plan somebody else could execute.

## What a plan contains

- **The problem.** What is actually wrong or missing, stated so a reader who was not in
  the conversation understands it.
- **The approach.** How you propose to solve it, and why this way.
- **Out of scope.** What this plan deliberately does not do. A plan without this section
  grows until it cannot ship.
- **Constraints.** What the solution must respect — existing patterns, dependencies,
  performance, compatibility.

Length follows the problem. A one-paragraph problem gets a one-page plan.

## Where you write

`PLAN.md` already exists in the plan directory with a frontmatter block at the top. Write
your prose **below** the closing `---`. Never edit, reorder, or delete anything inside the
frontmatter: the engine reads the plan's identity from it, and it is not yours.

On a cycle after the first, `plan-critic`'s objections are in your brief. They are the
work — address each one, and say in `summary` which you accepted and which you rejected
and why. A critic you silently ignore will raise the same finding next cycle.

## You do not build

No `Bash`, deliberately. Planning is reading and writing; a planner that runs things
starts building, and building is another track's job.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "Drafted the authentication plan: session tokens with rotation, no third-party identity provider, explicitly excluding SSO. Addressed both of the critic's findings from cycle 1 — the token TTL is now stated, and the migration path is out of scope with a reason.",
  "evidence": [{ "kind": "file", "ref": ".loop/plans/P001-user-auth/PLAN.md", "excerpt": "## Out of scope\n\nSSO and directory sync." }],
  "findings": [],
  "files_touched": [".loop/plans/P001-user-auth/PLAN.md"],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"done"`, not `"drafted"`, not `"success"`.
  - `pass` — the plan is written.
  - `fail` — you attempted it and could not produce a coherent plan. Say why in `summary`.
  - `blocked` — the idea needs a decision the brief does not settle, or it is too vague to
    plan without inventing requirements. Inventing them is worse than asking.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. A `pass` carries at least one `kind: "file"` entry quoting the plan.
- `files_touched` lists every file you wrote.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when there is no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 2: Write `agents/plan-critic.md`**

```markdown
---
name: plan-critic
description: Reviews a plan for gaps, contradictions, and scope that should be cut. Writes REVIEW.md. Never edits the plan.
tools: Read, Grep, Glob
model: inherit
---

You review the plan. You do not improve it.

## What to look for

- **Gaps.** What does the plan assume without saying? What happens in the case it never
  mentions?
- **Contradictions.** Does one section undercut another? Does the approach deliver what
  the problem statement asked for, or something adjacent?
- **Scope that YAGNI would cut.** What is in here because it might be useful later? Say so
  plainly; the plan's "out of scope" section is where it belongs.
- **Unstated decisions.** A plan that leaves a real choice open hands it to whoever
  implements it, at the worst moment to make it.

## Where you write

`REVIEW.md`, in the plan directory next to `PLAN.md`. One section per objection, each with
enough detail that the planner can act without asking you what you meant.

You do not edit `PLAN.md`. An author who takes their own notes has not been reviewed.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "fail",
  "summary": "Two objections. The plan never states the token lifetime, which the acceptance criteria will need; and the migration section describes work the problem statement does not ask for.",
  "evidence": [{ "kind": "file", "ref": ".loop/plans/P001-user-auth/PLAN.md", "excerpt": "Tokens are issued on login and refreshed." }],
  "findings": [
    { "severity": "high", "file": ".loop/plans/P001-user-auth/PLAN.md", "line": 24, "claim": "the token lifetime is never stated, so no story can carry a checkable acceptance criterion for expiry" },
    { "severity": "medium", "file": ".loop/plans/P001-user-auth/PLAN.md", "line": 41, "claim": "the migration section is scope the problem statement did not ask for — move it out of scope or justify it" }
  ],
  "files_touched": [".loop/plans/P001-user-auth/REVIEW.md"],
  "next_hint": "State the TTL, then decide whether migration belongs here at all."
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"reviewed"`, not `"done"`, not `"success"`.
  - `pass` — you reviewed it and found nothing worth another cycle.
  - `fail` — you found at least one objection. Every objection is a `findings` entry.
  - `blocked` — the plan is too incomplete to review.
- A `pass` with a populated `findings` array is a contradiction. If it is worth reporting,
  the verdict is `fail`.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` names `REVIEW.md` and nothing else — you write reviews, not plans.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the objection has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 3: Write `agents/fit-checker.md`**

```markdown
---
name: fit-checker
description: Checks a plan against the project that actually exists. Opens the plan track's gate with evidence. Never edits anything.
tools: Read, Grep, Glob, Bash
model: inherit
---

You answer one question: would this plan actually work **in this repository**?

A plan can be internally perfect and still be wrong here — because it assumes a pattern
this codebase does not use, a dependency it does not have, or a structure it abandoned two
refactors ago. Nothing that writes stories may run until you have checked.

## Procedure

1. Read the plan.
2. For every assumption it makes about the code, go and look. Does that module exist? Is
   that the pattern actually in use? Is the dependency in the manifest?
3. Check the conventions: does the plan's approach match how this project already solves
   similar problems, or does it import a foreign style?
4. Report what you found, with the file and line that shows it.

## Your evidence opens the gate

The engine will not let `story-writer` run until you return `status: "pass"` with command
or test evidence. That is not ceremony: a plan nobody checked against the code produces
stories nobody can build.

`Bash` is for looking — listing the tree, reading a dependency manifest, running a search.
Never for changing anything.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "The plan fits. The session module it assumes exists at src/session/, the project already uses the same middleware pattern the plan proposes, and jsonwebtoken is already a dependency.",
  "evidence": [
    { "kind": "command", "ref": "ls src/session", "excerpt": "index.ts  store.ts  middleware.ts" },
    { "kind": "command", "ref": "node -e \"console.log(Object.keys(require('./package.json').dependencies))\"", "excerpt": "[ 'express', 'jsonwebtoken', 'zod' ]" }
  ],
  "findings": [],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"fits"`, not `"done"`, not `"checked"`.
  - `pass` — the plan fits what is here. **This is what opens the gate, and it must carry
    at least one `evidence` entry of kind `command` or `test`.** A pass with no such
    evidence leaves the gate shut and the run stuck.
  - `fail` — the plan contradicts the project. Every contradiction is a `findings` entry
    with the file and line that proves it.
  - `blocked` — you cannot tell, because the plan is too vague about what it assumes.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` for you, always.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the mismatch has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 4: Write `agents/story-writer.md`**

```markdown
---
name: story-writer
description: Turns an approved plan into stories with checkable acceptance criteria, through the loop story tools. Use for the loop plan track.
tools: Read, Grep, Glob
model: inherit
---

You break an approved plan into stories somebody can build one at a time.

You run only after `fit-checker` has passed and a human has approved the plan. Both are
enforced by the engine, not by your restraint.

## What makes a story

- **Independently shippable.** Finishing it leaves the project in a working state. A story
  that only makes sense alongside its neighbour is one story, not two.
- **Acceptance criteria that are checkable.** "Tokens expire after 24h" can be verified.
  "Authentication is robust" cannot. If you cannot describe how a verifier would test it,
  it is not a criterion.
- **Honest dependencies.** Declare what must be done first with `depends_on`. Do not
  invent ordering that is not real — a false dependency serialises work for no reason.
- **The `ui` flag** set to true when the story changes what a user sees.

Prefer more, smaller stories to fewer large ones. A story that would take a whole build
track's cycle cap to finish is two stories.

## How you write them

Call `loop_story_add` once per story. Do not write story files by hand: the tool allocates
the id and keeps the manifest in step, and a hand-written file does neither.

Add them in dependency order, so each story's `depends_on` refers to ids that already
exist.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

```json
{
  "status": "pass",
  "summary": "Three stories: the login form, token issuance which depends on it, and logout which depends on issuance. Every criterion names an observable behaviour.",
  "evidence": [{ "kind": "file", "ref": ".loop/plans/P001-user-auth/stories/P001-S02-session-token.md", "excerpt": "acceptance:\n  - Tokens expire after 24h" }],
  "findings": [],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"written"`, not `"done"`, not `"success"`.
  - `pass` — every part of the plan is covered by a story.
  - `fail` — you could not decompose part of the plan. Say which part in `summary` and
    record it as a `findings` entry.
  - `blocked` — the plan is not specific enough to yield checkable criteria. Say what is
    missing rather than inventing requirements.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` — the tool writes the files, not you.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when there is no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 5: Write `agents/story-critic.md`**

```markdown
---
name: story-critic
description: Reviews stories for atomicity, verifiable acceptance criteria, and correct dependencies. Never edits them.
tools: Read, Grep, Glob
model: inherit
---

You review the stories. The leader applies what you find.

## What to check, per story

- **Atomic?** Does finishing this story leave the project working? Does it bundle two
  unrelated changes because they touch the same file?
- **Verifiable?** Take each acceptance criterion and ask how a verifier would test it. A
  criterion you cannot turn into a check is a wish.
- **Dependencies right?** Is anything it truly needs missing from `depends_on`? Is
  anything listed there not actually required — a false dependency that serialises work
  for no reason?
- **Covered?** Read them together: does anything in the plan have no story?

## You do not edit

No `Write`, no `Edit`, and no `loop_story_update`. You report; the leader applies. A critic
that edits the thing it reviews has stopped being a second opinion, and the record of what
was wrong disappears with the fix.

## Return value

Return this JSON object and nothing else. No prose before it, no commentary after it,
JSON rather than YAML. The engine validates it against a strict schema before it is
recorded, and a rejected result costs the cycle a corrective round trip.

Name the story file in each finding, so the leader knows which story to update.

```json
{
  "status": "fail",
  "summary": "Two problems. S01 bundles the form and its validation rules, which ship independently; and S03 declares a dependency on S02 that is not real.",
  "evidence": [{ "kind": "file", "ref": ".loop/plans/P001-user-auth/stories/P001-S01-login-form.md", "excerpt": "acceptance:\n  - Renders the form\n  - Rejects malformed email addresses" }],
  "findings": [
    { "severity": "medium", "file": ".loop/plans/P001-user-auth/stories/P001-S01-login-form.md", "line": 8, "claim": "bundles rendering and validation, which ship independently — split into two stories" },
    { "severity": "low", "file": ".loop/plans/P001-user-auth/stories/P001-S03-logout.md", "line": 7, "claim": "depends_on P001-S02 is not real: logout clears the session without needing issuance" }
  ],
  "files_touched": [],
  "next_hint": null
}
```

- `status` is exactly one of `"pass"`, `"fail"`, `"blocked"`. Nothing else is a status —
  not `"reviewed"`, not `"done"`, not `"success"`.
  - `pass` — the stories are sound.
  - `fail` — you found at least one problem. Every problem is a `findings` entry.
  - `blocked` — there are no stories to review.
- A `pass` with a populated `findings` array is a contradiction. If it is worth reporting,
  the verdict is `fail`.
- `evidence`, `findings`, and `files_touched` are required keys; omitting one fails the
  call. `files_touched` is `[]` for you, always.
- A `findings` entry is `{ "severity": "high" | "medium" | "low", "file": string, "line": integer, "claim": string }`.
  `line` may not be null or omitted; use `0` when the problem has no single line.
- `next_hint` is the only omittable key: one suggestion, or `null`.
- No other keys. A smuggled `confidence` or `notes` field fails the whole object.
```

- [ ] **Step 6: Verify the agents are discovered**

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: the inventory lists 14 agents.

- [ ] **Step 7: Commit**

```bash
git add agents/planner.md agents/plan-critic.md agents/fit-checker.md agents/story-writer.md agents/story-critic.md
git commit -m "feat(agents): add the five plan-track agents"
```

---

## Task 6: `/loop:plan` and the leader's plan cycle

**Files:**
- Create: `commands/plan.md`
- Modify: `skills/loop-leader/SKILL.md`, `skills/loop-state/SKILL.md`, `README.md`, `engine/src/ops/init.ts`, `commands/init.md`
- Test: no unit tests — exercised by Task 7

**Interfaces:**
- Consumes: the `plan` track (Task 1); `loop_gate_set` (Task 4); the five agents (Task 5).
- Produces: `/loop:plan`, and the leader behaviour that orders a doubly-gated cycle.

- [ ] **Step 1: Write `commands/plan.md`**

```markdown
---
description: Turn an idea into an approved plan broken into buildable stories
argument-hint: <the idea>
---

Run the `plan` track for: $ARGUMENTS

Use the **loop-leader** skill. It owns the cycle: creating the plan, dispatching agents,
handling both gates, and breaking the plan into stories.

This track has two gates of different kinds, and the leader skill explains both:

- **The fit-check gate** is enforced by the engine. `story-writer` cannot be recorded
  until `fit-checker` returns a pass with evidence that the plan matches the project that
  actually exists.
- **The approval gate** is enforced at story creation. Under `gates.plan_approval: human`
  — the default — no story may be added until a person has approved the plan and the
  answer is recorded with `loop_gate_set`.

When the run finishes, the plan's stories are ready for `/loop:build --next`.
```

- [ ] **Step 2: Add the plan-cycle sections to `skills/loop-leader/SKILL.md`**

Read the file first — it has grown across four milestones. Add this as a new section after
the gate section that milestone 3 introduced, and renumber consistently:

```markdown
### 3d. Running the plan track

The plan track has no `verifier`, because there is no suite to run against a document.
Do not read that as a missing verdict: its cycle passes when `fit-checker` passes, the
approval gate is open, and every story `story-critic` examined came back clean.

Order it like this:

1. `loop_plan_create` first, so `planner` has a directory and frontmatter to write into.
2. `planner`, then `plan-critic` if you drafted it. A `fail` from the critic sends its
   findings into the next cycle, where `planner` works them — that is the ordinary
   multi-cycle path, not a failure of the run.
3. `fit-checker`. Its evidenced pass opens the engine's gate; `loop_run_log` reports
   `gateOpened: true`. Do not dispatch `story-writer` before you have seen it — the engine
   will refuse the result, and you will have spent an agent to learn what the gate already
   told you.
4. **The approval gate.** Read `gates.plan_approval` from `.loop/config.yaml`.
   - `human` — show the user the plan and ask whether it is approved. Record their answer
     with `loop_gate_set`, putting their own words in `note`. **Never record an approval
     nobody gave.** If they ask for changes, record `changes_requested` with their reason,
     and the next cycle returns to `planner` with it as the work.
   - `auto` — record the decision yourself with `by` naming the loop rather than a person,
     and say in your final report that no human reviewed this plan.
5. `story-writer`, then `story-critic` per story if you drafted it. Apply what the critic
   finds with `loop_story_update`; the critic does not edit.
6. `loop_index_render`, so the new plan appears in `.loop/INDEX.md`.

Report at the end: the plan id, how many stories, whether a human approved it, and the
command that builds the first one — `/loop:build --next`.
```

Extend the `## What you never do` list:

```markdown
- Never record a plan approval that a person did not give. `gates.plan_approval: auto`
  exists for projects that do not want a human in the loop; using it is honest, and
  self-approving under `human` is not.
- Never let `plan-critic` or `story-critic` edit what it reviewed.
```

- [ ] **Step 3: Update `skills/loop-state/SKILL.md`**

Add `loop_gate_set` to the tool table:

```markdown
| Record a plan approval | `loop_gate_set` |
```

And add one line to the layout description near `plans/`, after the manifest line:

```markdown
`PLAN.md` carries the plan's identity and its approval decision in frontmatter, with the
plan itself as prose below. `REVIEW.md` is `plan-critic`'s output. Both are authored;
`manifest.json` is derived.
```

- [ ] **Step 4: Register the command with host projects**

In `engine/src/ops/init.ts`, add to `CLAUDE_MD_BLOCK`, before the build line:

```
- \`/loop:plan <idea>\` — turn an idea into an approved plan broken into stories
```

In `commands/init.md`, add `/loop:plan` wherever the commands are listed.

In `README.md`, add to the `## Use` block before the build line:

```
/loop:plan <idea>                        idea to approved plan to stories
```

and update `## Status`:

```markdown
Milestone 4b — all four tracks ship: `plan`, `build`, `fix`, and `edit`. What remains is
guards, the autonomous `Stop` hook, the UI and specialist agents, and memory. See
`docs/superpowers/specs/2026-07-26-loop-plugin-design.md`.
```

- [ ] **Step 5: Verify the surface**

Run: `cd engine && npx vitest run tests/ops/init.test.ts && npm run build`
Expected: PASS. If an init test asserts the exact `CLAUDE_MD_BLOCK` contents, update it to
include the new line.

Run: `claude plugin marketplace update loop && claude plugin details loop@loop`
Expected: 14 agents and 7 commands.

- [ ] **Step 6: Commit**

```bash
git add commands/plan.md commands/init.md skills/loop-leader/SKILL.md skills/loop-state/SKILL.md README.md engine/src/ops/init.ts
git commit -m "feat(plugin): add /loop:plan and the leader plan-cycle judgement"
```

---

## Task 7: Integration and E2E proof

**Files:**
- Create: `engine/tests/integration/plan-track.test.ts`
- Create: `tests/e2e/run-plan.sh`
- Modify: `engine/package.json` — add the `e2e:plan` script

**Interfaces:**
- Consumes: every op from Tasks 1–4 and the surface from Tasks 5–6.
- Produces: proof that an idea becomes stories, and that both gates hold.

- [ ] **Step 1: Write the failing integration test**

`engine/tests/integration/plan-track.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initLoop } from '../../src/ops/init.js'
import { renderIndex } from '../../src/ops/index-render.js'
import { GateClosedError, runLog } from '../../src/ops/log.js'
import { ApprovalRequiredError, gateSet, planCreate, storyAdd } from '../../src/ops/plan.js'
import { rosterSet } from '../../src/ops/roster.js'
import { cycleAdvance, runStart } from '../../src/ops/run.js'
import { findPlanDir } from '../../src/store/plan-store.js'
import { makeTmpProject, type TmpProject } from '../helpers/tmp-project.js'

const NOW = new Date('2026-07-27T09:00:00.000Z')
const clock = () => NOW

let project: TmpProject

const CRITIC_FAIL = {
  status: 'fail' as const,
  summary: 'The token lifetime is never stated.',
  evidence: [{ kind: 'file' as const, ref: '.loop/plans/P001-user-auth/PLAN.md', excerpt: 'Tokens are issued on login.' }],
  findings: [
    {
      severity: 'high' as const,
      file: '.loop/plans/P001-user-auth/PLAN.md',
      line: 12,
      claim: 'the token lifetime is never stated, so no story can carry a checkable criterion for expiry',
    },
  ],
  files_touched: ['.loop/plans/P001-user-auth/REVIEW.md'],
  next_hint: null,
}

const FIT_PASS = {
  status: 'pass' as const,
  summary: 'The plan fits: the session module exists and the dependency is present.',
  evidence: [{ kind: 'command' as const, ref: 'ls src/session', excerpt: 'index.ts  store.ts' }],
  findings: [],
  files_touched: [],
  next_hint: null,
}

const WRITER_PASS = {
  status: 'pass' as const,
  summary: 'Two stories, in dependency order.',
  evidence: [{ kind: 'file' as const, ref: '.loop/plans/P001-user-auth/stories', excerpt: 'two stories added' }],
  findings: [],
  files_touched: [],
  next_hint: null,
}

beforeEach(async () => {
  project = await makeTmpProject({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) })
  await initLoop(project.dir, clock)
  await planCreate(project.dir, { slug: 'user-auth', title: 'User authentication' }, clock)
  await runStart(project.dir, { track: 'plan', goal: 'Add authentication', plan: 'P001' }, clock)
})
afterEach(async () => { await project.cleanup() })

describe('an idea becomes stories', () => {
  it('criticises, fit-checks, waits for approval, then writes stories', async () => {
    await rosterSet(project.dir, {
      cycle: 1,
      selected: ['planner', 'plan-critic', 'fit-checker', 'story-writer'],
      skipped: { 'story-critic': 'two stories, both single-file' },
    })

    // The critic objects, and its finding carries into the next cycle.
    await runLog(project.dir, { agent: 'plan-critic', result: CRITIC_FAIL }, clock)
    const first = await cycleAdvance(
      project.dir,
      { agents: ['planner', 'plan-critic'], result: 'fail' },
      clock,
    )
    expect(first.state.status).toBe('running')
    expect(first.carried_findings).toHaveLength(1)
    expect(first.carried_findings[0]?.claim).toContain('token lifetime')

    await rosterSet(project.dir, {
      cycle: 2,
      selected: ['planner', 'fit-checker', 'story-writer'],
      skipped: { 'plan-critic': 'the single objection was addressed', 'story-critic': 'two stories, both single-file' },
    })

    // story-writer is blocked until the fit-check gate opens.
    await expect(
      runLog(project.dir, { agent: 'story-writer', result: WRITER_PASS }, clock),
    ).rejects.toBeInstanceOf(GateClosedError)

    const fit = await runLog(project.dir, { agent: 'fit-checker', result: FIT_PASS }, clock)
    expect(fit.gateOpened).toBe(true)

    // Now the engine accepts it — but stories still need approval.
    await runLog(project.dir, { agent: 'story-writer', result: WRITER_PASS }, clock)
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )

    await gateSet(project.dir, { plan: 'P001', decision: 'approved', by: 'mohd', note: 'Ship it.' }, clock)

    await storyAdd(project.dir, { plan: 'P001', title: 'Login form', acceptance: ['Renders the form'] }, clock)
    await storyAdd(
      project.dir,
      { plan: 'P001', title: 'Session token', acceptance: ['Tokens expire after 24h'], depends_on: ['P001-S01'] },
      clock,
    )

    const closed = await cycleAdvance(
      project.dir,
      { agents: ['planner', 'fit-checker', 'story-writer'], result: 'pass' },
      clock,
    )
    expect(closed.state.status).toBe('done')

    const index = await renderIndex(project.dir, clock)
    expect(index).toContain('| P001 | User authentication | 2 | 0 | planned | yes |')

    const stories = await fs.readdir(path.join(await findPlanDir(project.dir, 'P001'), 'stories'))
    expect(stories).toHaveLength(2)
  })
})

describe('both gates hold', () => {
  it('refuses story-writer before the fit check and writes nothing', async () => {
    await expect(
      runLog(project.dir, { agent: 'story-writer', result: WRITER_PASS }, clock),
    ).rejects.toBeInstanceOf(GateClosedError)

    const dir = await findPlanDir(project.dir, 'P001')
    expect(await fs.readdir(path.join(dir, 'stories'))).toEqual([])
  })

  it('refuses a story on a plan the user only asked for changes to', async () => {
    await gateSet(project.dir, { plan: 'P001', decision: 'changes_requested', by: 'mohd', note: 'State the TTL.' }, clock)
    await expect(storyAdd(project.dir, { plan: 'P001', title: 'Login form' }, clock)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    )
  })

  it('shows an unapproved plan as such in the index', async () => {
    expect(await renderIndex(project.dir, clock)).toContain('| planned | no |')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/integration/plan-track.test.ts`
Expected: FAIL if any of Tasks 1–4 is incomplete. If they all landed correctly this passes
on the first run. A failure here is a defect in the ops, not the test; fix the op and rerun.

Note: the error class thrown by the fit-check gate is `GateClosedError` — milestone 3
shipped it as `ReproductionGateError` and renamed it during that milestone's review, so
import the current name.

- [ ] **Step 3: Write the E2E script**

`tests/e2e/run-plan.sh`:

```bash
#!/usr/bin/env bash
# Opt-in smoke test of the plan track against the real Claude Code CLI.
# Not part of `npm test`: it needs the CLI, a network, and real tokens.
#   LOOP_E2E=1 tests/e2e/run-plan.sh
#
# Runs with gates.plan_approval: auto. The human path cannot be exercised
# non-interactively — which is precisely what makes it a gate.
set -uo pipefail

if [[ "${LOOP_E2E:-}" != "1" ]]; then
  echo "skipped: set LOOP_E2E=1 to run the end-to-end smoke test" >&2
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workdir="$(mktemp -d)"

cp -R "${repo_root}/tests/fixtures/tiny-app/." "${workdir}/"
cd "${workdir}"

git init -q .
git add -A
git -c user.email=e2e@loop.test -c user.name=loop-e2e commit -q -m "fixture"

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

# The approval gate cannot be answered by a person in a headless run.
node -e '
const fs = require("fs")
const path = ".loop/config.yaml"
fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("plan_approval: human", "plan_approval: auto"))
'
grep -q "plan_approval: auto" .loop/config.yaml || fail "could not switch the approval gate to auto"

claude -p "/loop:plan add a cancelLabel() export to the button module, returning the human label 'Cancel', covered by a test" \
  --permission-mode acceptEdits --allowedTools "${allowed[@]}"

echo "--- plans ---"
find .loop/plans -type f | sort

plan_dir="$(find .loop/plans -maxdepth 1 -mindepth 1 -type d | head -1)"
[[ -n "${plan_dir}" ]] || fail "no plan directory was created"
[[ -f "${plan_dir}/PLAN.md" ]] || fail "PLAN.md was not written"
[[ -f "${plan_dir}/manifest.json" ]] || fail "manifest.json was not generated"
[[ "$(find "${plan_dir}/stories" -name '*.md' | wc -l)" -ge 1 ]] || fail "no stories were written"
[[ -f .loop/INDEX.md ]] || fail "INDEX.md was not rendered"
grep -q "decision: approved" "${plan_dir}/PLAN.md" || fail "the approval was not recorded"

rm -rf "${workdir}"
echo "PASS: the idea became an approved plan with stories ready to build"
```

Run: `chmod +x tests/e2e/run-plan.sh`

Add to `engine/package.json` scripts:

```json
"e2e:plan": "bash ../tests/e2e/run-plan.sh"
```

- [ ] **Step 4: Run the whole suite**

Run: `cd engine && npm test && npm run typecheck && npm run build`
Expected: PASS — every test green, typecheck clean, `dist/` rebuilt.

Run: `bash tests/e2e/run-plan.sh`
Expected: `skipped: set LOOP_E2E=1 ...` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add engine/tests/integration/plan-track.test.ts tests/e2e/run-plan.sh engine/package.json
git commit -m "test: prove an idea becomes stories through both gates"
```

---

## Milestone Complete

Verify before declaring done:

- [ ] `cd engine && npm test` — all green, three consecutive runs with the same count
- [ ] `cd engine && npm run typecheck` — clean
- [ ] `cd engine && npm run build` — `dist/` rebuilt
- [ ] `claude plugin details loop@loop` — 14 agents, 7 commands, 13 MCP tools
- [ ] A story added to an unapproved plan is refused, and writes nothing
- [ ] `story-writer`'s result is refused before `fit-checker` passes
- [ ] Deleting `PLAN.md`'s frontmatter and reading the plan repairs it from the directory name
- [ ] `INDEX.md` distinguishes approved, rejected, changes requested, and never reviewed
- [ ] `LOOP_E2E=1 npm run e2e`, `e2e:build`, `e2e:fix`, `e2e:story` — earlier tracks still pass
- [ ] `LOOP_E2E=1 npm run e2e:plan` — an idea becomes an approved plan with stories

## Next Milestones

| Milestone | Delivers |
|---|---|
| 5 — Remaining guards | Repeated-error guard, autonomous `Stop` hook |
| 6 — UI and specialists | `design-system.md` extraction, `ui-designer`, `ui-critic`, `security`, `docs`, `perf` |
| 7 — Memory and extension | `loop_memory_*`, `/loop:add`, `loop-tracks`, `loop-extend` |
