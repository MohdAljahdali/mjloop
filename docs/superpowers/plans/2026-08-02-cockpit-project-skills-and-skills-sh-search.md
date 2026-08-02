# Cockpit: project skills on disk, and skills.sh search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cockpit's Skills page show the skills that actually exist in the project on disk, and let a person search skills.sh (and GitHub) for a new one from both the cockpit and the CLI.

**Architecture:** Two independent additions to an existing read-only surface. (1) A new pure-read op, `ops/project-skills.ts`, walks `<projectDir>/.claude/skills/*/SKILL.md`, is projected into the existing `SkillsView`, rides the existing `revisions.skills` fingerprint, and is drawn as a fourth block on the Skills panel. Whether a listed skill is *routed* by mjloop is joined client-side against `acceptances`, exactly as `joinAcceptances` already joins acceptances against library packages. (2) A new `skills-sh` connector inside the existing `ops/skill-discovery.ts`, reachable from `mjloop-cli skills search --source skills-sh` and from one new **read** route, `GET /api/skills/search`. Import stays a command; nothing in this plan lets the browser write.

**Tech Stack:** TypeScript (ESM, Node ≥20), zod v4 schemas, vitest, and the cockpit's own vanilla-JS panel system (`ui/render.js` `register`/`draw`, `ui/list.js` `reconcile`, `ui/dom.js` `clone`/`phrase`/`verbatim`, `ui/bus.js` delegated `data-act`).

## Global Constraints

- Every source file lives under `engine/`. Paths below are relative to the repository root.
- **Nothing in this plan gives the browser a write.** `web/writes.ts`'s header lists the only four engine writes the browser may reach; accepting or importing a skill is permanently not one of them. `GET /api/skills/search` is a read that performs a network *search* and writes nothing to disk.
- **The wire carries codes, never prose.** `web/codes.ts`'s `WEB_CODES` is a closed union; `tests/web/locales.test.ts` asserts every code has an `en.json` key. A refusal that needs a sentence gets a code plus a locale string in **both** `en.json` and `ar.json`.
- Every network call in `ops/skill-discovery.ts` goes through `deps.fetch` — never a bare `fetch(`. Tests inject a fake; nothing in that module may reach the network under test.
- Discovery stays **search-only and metadata-only**: no candidate is written to the library, and the only path to something a project can use runs through `inspectCandidate` and a passed sandbox.
- `orchestration.skills.sources` stays the allowlist and its default stays `['github']`. `skills-sh` is opt-in per project, like every other source.
- Locale keys go in `engine/src/web/public/locales/en.json` **and** `ar.json`. `tests/web/locales.test.ts` enforces the pairing.
- Verify with `cd engine && npm test` and `npm run typecheck` (the latter runs both `tsconfig.json` and `tsconfig.web.json`).
- **skills.sh requires authentication.** Verified 2026-08-02: `GET https://skills.sh/api/v1/skills/search?q=react` returns `401 {"error":"authentication_required"}` and asks for a Vercel OIDC token. The connector reads the token from the environment and refuses by name when it is absent — it never reports "no results" for "no token".

## File Structure

**New:**
- `engine/src/schemas/project-skills.ts` — the shape of one skill found on disk, and the `SKILL.md` frontmatter schema.
- `engine/src/ops/project-skills.ts` — `readProjectSkills(projectDir)`: the walk, and nothing else.
- `engine/tests/ops/project-skills.test.ts`
- `engine/tests/ops/skills-sh-discovery.test.ts`

**Modified:**
- `engine/src/web/read.ts` — `SkillsView` gains `onDisk` and `onDiskUnreadable`.
- `engine/src/web/revision.ts` — the `skills` fingerprint gains `.claude/skills`.
- `engine/src/web/api.ts` — `case 'skills'` gains the `search` sub-route.
- `engine/src/web/codes.ts` — three discovery refusal codes.
- `engine/src/schemas/config.ts` — `SkillSourceSchema` gains `'skills-sh'`.
- `engine/src/ops/skill-discovery.ts` — the `skills-sh` connector, `deps.env`, `SkillsShTokenMissingError`.
- `engine/src/cli/index.ts` — the new source in help text and in the `--source` refusal.
- `engine/src/web/public/index.html` — one new block, two new templates, the search form.
- `engine/src/web/public/panels/skills.js` — draw the on-disk block, run the search.
- `engine/src/web/public/app.js` — register the `skills-search` action.
- `engine/src/web/public/locales/en.json`, `ar.json`
- `engine/tests/web/read.test.ts`, `engine/tests/web/api.test.ts`, `engine/tests/web/panels.test.ts`
- `docs/usage.md`, `docs/usage.ar.md`

---

### Task 1: Read the project's skills off disk

**Files:**
- Create: `engine/src/schemas/project-skills.ts`
- Create: `engine/src/ops/project-skills.ts`
- Test: `engine/tests/ops/project-skills.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` from `engine/src/store/frontmatter.ts` (signature: `(raw: string) => { data: unknown; body: string }`, throws `FrontmatterError`).
- Produces: `ProjectSkillOnDisk` (`{ name: string; description: string; path: string }`), `UnreadableProjectSkill` (`{ path: string; reason: string }`), and `readProjectSkills(projectDir: string): Promise<{ skills: ProjectSkillOnDisk[]; unreadable: UnreadableProjectSkill[] }>`. Tasks 2, 3 and 8 rely on exactly these names.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/ops/project-skills.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readProjectSkills } from '../../src/ops/project-skills.js'
import { makeTempProject } from '../helpers/tmp-project.js'

/** Write one `.claude/skills/<name>/SKILL.md` under `dir`. */
async function writeSkill(dir: string, name: string, body: string): Promise<void> {
  const at = path.join(dir, '.claude', 'skills', name)
  await fs.mkdir(at, { recursive: true })
  await fs.writeFile(path.join(at, 'SKILL.md'), body, 'utf8')
}

describe('readProjectSkills', () => {
  it('answers empty for a project with no .claude/skills directory', async () => {
    const dir = await makeTempProject()
    await expect(readProjectSkills(dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('reads name, description and a repository-relative path, sorted by name', async () => {
    const dir = await makeTempProject()
    await writeSkill(dir, 'zebra', '---\nname: zebra\ndescription: Use when striping.\n---\n\nBody.\n')
    await writeSkill(dir, 'alpha', '---\nname: alpha\ndescription: Use when starting.\n---\n\nBody.\n')

    const { skills, unreadable } = await readProjectSkills(dir)
    expect(unreadable).toEqual([])
    expect(skills).toEqual([
      { name: 'alpha', description: 'Use when starting.', path: '.claude/skills/alpha/SKILL.md' },
      { name: 'zebra', description: 'Use when striping.', path: '.claude/skills/zebra/SKILL.md' },
    ])
  })

  it('reports a skill it could not read rather than dropping it or throwing', async () => {
    const dir = await makeTempProject()
    await writeSkill(dir, 'good', '---\nname: good\ndescription: Use when fine.\n---\n\nBody.\n')
    await writeSkill(dir, 'nofrontmatter', 'Just a body, no frontmatter at all.\n')
    await writeSkill(dir, 'nodescription', '---\nname: nodescription\n---\n\nBody.\n')

    const { skills, unreadable } = await readProjectSkills(dir)
    expect(skills.map((skill) => skill.name)).toEqual(['good'])
    expect(unreadable.map((entry) => entry.path).sort()).toEqual([
      '.claude/skills/nodescription/SKILL.md',
      '.claude/skills/nofrontmatter/SKILL.md',
    ])
    for (const entry of unreadable) expect(entry.reason.length).toBeGreaterThan(0)
  })

  it('ignores a directory with no SKILL.md and a loose file beside the directories', async () => {
    const dir = await makeTempProject()
    await fs.mkdir(path.join(dir, '.claude', 'skills', 'empty'), { recursive: true })
    await fs.writeFile(path.join(dir, '.claude', 'skills', 'README.md'), '# not a skill\n', 'utf8')

    await expect(readProjectSkills(dir)).resolves.toEqual({ skills: [], unreadable: [] })
  })

  it('prefers the frontmatter name over the directory name, and records it', async () => {
    const dir = await makeTempProject()
    await writeSkill(dir, 'dir-name', '---\nname: declared-name\ndescription: Use when renamed.\n---\n\nBody.\n')

    const { skills } = await readProjectSkills(dir)
    expect(skills[0]?.name).toBe('declared-name')
    expect(skills[0]?.path).toBe('.claude/skills/dir-name/SKILL.md')
  })
})
```

Check `engine/tests/helpers/tmp-project.ts` for the exported helper's real name before running; if it is not `makeTempProject`, use the name it exports and keep the rest of the test unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/project-skills.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/ops/project-skills.js"`.

- [ ] **Step 3: Write the schema**

Create `engine/src/schemas/project-skills.ts`:

```ts
/**
 * The skills that exist in this project's own checkout, as facts rather than
 * as decisions.
 *
 * `.claude/skills/` is where Claude Code reads a project's skills from, and
 * no setting anywhere redirects that (see `LEGACY_CONFIG_KEYS` in
 * `schemas/config.ts`, which removed a setting that claimed otherwise). A
 * skill being *here* means the session can load it; it says nothing about
 * whether mjloop routes work to it — that is what an acceptance in
 * `.mjloop/skills/` says, and the two are joined for display and nowhere
 * else. Keeping them separate types is the point: a page that showed only
 * acceptances told a project full of skills that it had none.
 */
import * as z from 'zod'

/**
 * The two frontmatter fields Claude Code itself requires of a `SKILL.md`.
 *
 * Non-strict on purpose — a skill may declare `allowed-tools`, `license` or
 * anything else, and this walk has no business refusing a file over a key it
 * does not read.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1),
})

export const ProjectSkillOnDiskSchema = z.strictObject({
  /** The frontmatter's `name` — what the session addresses the skill by. */
  name: z.string().min(1).max(200),
  /** The frontmatter's `description` — when the skill applies, verbatim. */
  description: z.string().min(1),
  /** Repository-relative and always POSIX-separated, so it is quotable in a review. */
  path: z.string().min(1),
})

export type ProjectSkillOnDisk = z.infer<typeof ProjectSkillOnDiskSchema>

/** A `SKILL.md` this walk found and could not turn into a record, and why. */
export const UnreadableProjectSkillSchema = z.strictObject({
  path: z.string().min(1),
  reason: z.string().min(1),
})

export type UnreadableProjectSkill = z.infer<typeof UnreadableProjectSkillSchema>
```

- [ ] **Step 4: Write the walk**

Create `engine/src/ops/project-skills.ts`:

```ts
/**
 * A pure read of `<projectDir>/.claude/skills/`.
 *
 * No I/O beyond the one walk, nothing executed, and nothing written. A
 * malformed `SKILL.md` is *reported* rather than thrown on, for the reason
 * `listPackages` reports its unreadable entries: one bad file must not turn a
 * whole page into a 500, and silently dropping it is worse than saying so —
 * an invisible skill reads as a skill that does not exist.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from '../store/frontmatter.js'
import {
  SkillFrontmatterSchema,
  type ProjectSkillOnDisk,
  type UnreadableProjectSkill,
} from '../schemas/project-skills.js'

/** Where Claude Code reads a project's skills from. Not configurable, here or anywhere. */
export const PROJECT_SKILLS_DIR = path.join('.claude', 'skills')

export interface ProjectSkillsListing {
  skills: ProjectSkillOnDisk[]
  unreadable: UnreadableProjectSkill[]
}

/** POSIX-separated, so the same project reads the same on Windows as in a review. */
function repoRelative(dirName: string): string {
  return `.claude/skills/${dirName}/SKILL.md`
}

export async function readProjectSkills(projectDir: string): Promise<ProjectSkillsListing> {
  const root = path.join(projectDir, PROJECT_SKILLS_DIR)

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    // A project with no `.claude/skills/` is the state every project starts
    // in, and it is an empty answer rather than a failure — the position
    // `readSkillsView` already takes on an empty library.
    return { skills: [], unreadable: [] }
  }

  const skills: ProjectSkillOnDisk[] = []
  const unreadable: UnreadableProjectSkill[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const at = repoRelative(entry.name)
    const file = path.join(root, entry.name, 'SKILL.md')

    let raw: string
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch {
      // A directory with no `SKILL.md` is not a skill and not a fault: it is
      // most often a skill's `references/` or `assets/` sibling.
      continue
    }

    try {
      const { data } = parseFrontmatter(raw)
      const parsed = SkillFrontmatterSchema.safeParse(data)
      if (!parsed.success) {
        unreadable.push({
          path: at,
          reason: `its frontmatter is missing a required field: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
        })
        continue
      }
      skills.push({ name: parsed.data.name, description: parsed.data.description, path: at })
    } catch (error) {
      unreadable.push({ path: at, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name))
  unreadable.sort((left, right) => left.path.localeCompare(right.path))
  return { skills, unreadable }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine && npx vitest run tests/ops/project-skills.test.ts`
Expected: PASS, 5 tests.

If the `nofrontmatter` case fails because `parseFrontmatter` returns `{ data: undefined }` instead of throwing, that is fine — `safeParse` rejects `undefined` and the entry lands in `unreadable` through the first branch. Only adjust the expected `reason` text if the test asserts on it (it asserts only that it is non-empty).

- [ ] **Step 6: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/schemas/project-skills.ts engine/src/ops/project-skills.ts engine/tests/ops/project-skills.test.ts
git commit -m "feat(skills): read the skills a project actually has on disk"
```

---

### Task 2: Serve the on-disk skills, and make the page refresh when they change

**Files:**
- Modify: `engine/src/web/read.ts` (the `SkillsView` interface at :200 and `readSkillsView` at :241)
- Modify: `engine/src/web/revision.ts` (the `Promise.all` at :214 and the return at :232)
- Test: `engine/tests/web/read.test.ts`

**Interfaces:**
- Consumes: `readProjectSkills` and the two types from Task 1.
- Produces: `SkillsView` with two new fields — `onDisk: ProjectSkillOnDisk[]` and `onDiskUnreadable: UnreadableProjectSkill[]`. Tasks 3 and 7 read them off `/api/skills`.

- [ ] **Step 1: Write the failing test**

Append to `engine/tests/web/read.test.ts`, inside whichever `describe` already covers `readSkillsView` (search the file for it; if there is none, add `describe('readSkillsView', ...)` at the end):

```ts
  it('serves the skills the project has on disk beside the ones it accepted', async () => {
    const dir = await makeTempProject()
    const at = path.join(dir, '.claude', 'skills', 'brief-writer')
    await fs.mkdir(at, { recursive: true })
    await fs.writeFile(
      path.join(at, 'SKILL.md'),
      '---\nname: brief-writer\ndescription: Use when a request needs a brief.\n---\n\nBody.\n',
      'utf8',
    )

    const view = await readSkillsView(dir)
    expect(view.onDisk).toEqual([
      { name: 'brief-writer', description: 'Use when a request needs a brief.', path: '.claude/skills/brief-writer/SKILL.md' },
    ])
    expect(view.onDiskUnreadable).toEqual([])
    // The three lists it already served are untouched by this one.
    expect(view.acceptances).toEqual([])
    expect(view.packages).toEqual([])
  })
```

Match the file's existing imports for `fs`, `path`, `makeTempProject` and `readSkillsView` rather than adding duplicates.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/web/read.test.ts`
Expected: FAIL — `expected undefined to deeply equal [ … ]` on `view.onDisk`.

- [ ] **Step 3: Extend the view**

In `engine/src/web/read.ts`, add the import beside the other skill imports:

```ts
import { readProjectSkills } from '../ops/project-skills.js'
import type { ProjectSkillOnDisk, UnreadableProjectSkill } from '../schemas/project-skills.js'
```

Add these two fields to `interface SkillsView`, after `acceptances`:

```ts
  /**
   * The skills this project's own checkout holds, in `.claude/skills/`.
   *
   * Served beside the acceptances rather than folded into them because the
   * two answer different questions: this list is what the *session* can load,
   * the acceptances are what *mjloop* routes work to. A page that had only
   * the second told a project full of skills that it had none, which is the
   * defect this field closes. The join between them — is this skill routed? —
   * is made client-side against `skillId`, the same way `joinAcceptances`
   * joins an acceptance to its library package.
   */
  onDisk: ProjectSkillOnDisk[]
  /** A `SKILL.md` the walk could not read, and why. Surfaced, never dropped. */
  onDiskUnreadable: UnreadableProjectSkill[]
```

Replace the body of `readSkillsView`:

```ts
export async function readSkillsView(projectDir: string): Promise<SkillsView> {
  const [library, acceptances, onDisk] = await Promise.all([
    listPackages(projectDir),
    listAcceptances(projectDir),
    readProjectSkills(projectDir),
  ])
  return {
    packages: library.packages,
    unreadable: library.unreadable,
    acceptances,
    onDisk: onDisk.skills,
    onDiskUnreadable: onDisk.unreadable,
  }
}
```

- [ ] **Step 4: Make the fingerprint cover the new directory**

In `engine/src/web/revision.ts`, add `.claude/skills` to the parallel read. Change the destructuring and the array:

```ts
  const [state, config, memory, runs, profile, features, acceptances, library, projectSkills] = await Promise.all([
```

and append, after `stampLibrary(projectDir)`:

```ts
    // `.claude/skills` is outside `.mjloop/` and outside `paths` on purpose:
    // it is Claude Code's directory, not this engine's. It is stamped anyway
    // because the Skills panel now draws it, and a panel that never refreshes
    // when the thing it draws changes is a panel showing yesterday.
    stampTree(path.join(projectDir, '.claude', 'skills')),
```

and widen the returned fingerprint:

```ts
    skills: `${acceptances}|${library}|${projectSkills}`,
```

Confirm `path` is already imported in this file (it is — `stampTree(path.join(paths.plans, …))` is used above).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/web/ && npm run typecheck`
Expected: PASS. If a revision test asserts the exact `skills` fingerprint string, update its expectation to the three-part form — the extra segment is the behaviour under test, not a regression.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/web/read.ts engine/src/web/revision.ts engine/tests/web/read.test.ts
git commit -m "feat(web): serve the project's on-disk skills, and refresh when they change"
```

---

### Task 3: Draw the on-disk skills on the Skills panel

**Files:**
- Modify: `engine/src/web/public/index.html` (the `#panel-skills` section at :693, and the template block near :1532)
- Modify: `engine/src/web/public/panels/skills.js`
- Modify: `engine/src/web/public/locales/en.json`, `engine/src/web/public/locales/ar.json`
- Test: `engine/tests/web/panels.test.ts`

**Interfaces:**
- Consumes: `SkillsView.onDisk` / `.onDiskUnreadable` from Task 2.
- Produces: `routeOnDisk(view)` — exported from `panels/skills.js`, returns `{ skill, routedBy }[]` where `routedBy` is the matching `ProjectSkillAcceptance` or `null`. Task 7 does not use it; the panel test does.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/web/panels.test.ts`, beside the existing `joinAcceptances` tests:

```ts
describe('the skills a project has on disk', () => {
  it('pairs each on-disk skill with the acceptance that routes it, or with null', () => {
    const view = {
      packages: [],
      unreadable: [],
      acceptances: [
        { skillId: 'brief-writer', digest: 'a'.repeat(64), packageId: 'pkg', status: 'active', compatible: true,
          components: ['web'], agents: ['builder'], tags: [], updatePolicy: 'review',
          acceptedBy: 'mohd', acceptedAt: NOW } as unknown as ProjectSkillAcceptance,
      ],
      onDisk: [
        { name: 'brief-writer', description: 'Use when a request needs a brief.', path: '.claude/skills/brief-writer/SKILL.md' },
        { name: 'lonely', description: 'Use when nothing routes here.', path: '.claude/skills/lonely/SKILL.md' },
      ],
      onDiskUnreadable: [],
    }

    const routed = routeOnDisk(view as never)
    expect(routed.map((entry) => [entry.skill.name, entry.routedBy?.skillId ?? null])).toEqual([
      ['brief-writer', 'brief-writer'],
      ['lonely', null],
    ])
  })

  it('answers empty before the fetch has settled', () => {
    expect(routeOnDisk(null)).toEqual([])
  })
})
```

Add `routeOnDisk` to the existing `panels/skills.js` import at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/web/panels.test.ts`
Expected: FAIL — `routeOnDisk is not a function`.

- [ ] **Step 3: Add the markup**

In `engine/src/web/public/index.html`, insert this block inside `<section class="panel" id="panel-skills">`, **immediately before** the `<h2 data-i18n="skills.acceptances">` block (so the page reads: the map, what is here, what is routed, what the machine holds):

```html
        <section class="block">
          <h2 data-i18n="skills.onDisk"></h2>
          <p class="hint" data-i18n="skills.onDiskWhy"></p>
          <p class="empty" id="skills-ondisk-empty" hidden></p>
          <div id="skills-ondisk"></div>
          <div id="skills-ondisk-unreadable"></div>
        </section>
```

And add these two templates beside `<template id="tpl-package">` (near :1532). Copy the class names and element structure from the neighbouring `tpl-acceptance-record` template so the new rows inherit the panel's existing card styling — the slot names below are what `panels/skills.js` reads:

```html
    <template id="tpl-project-skill">
      <article class="card">
        <h3 data-slot="name"></h3>
        <p class="record" data-slot="routing"></p>
        <p data-slot="description"></p>
        <p class="hint" data-slot="path"></p>
      </article>
    </template>

    <template id="tpl-project-skill-unreadable">
      <p class="banner warn"><span data-slot="path"></span> — <span data-slot="reason"></span></p>
    </template>
```

Check how `data-slot` is actually spelled in the existing templates (`clone()` in `ui/dom.js` builds the `slots` map from them) and match it exactly; the slot **names** — `name`, `routing`, `description`, `path`, `reason` — are what the code below depends on.

- [ ] **Step 4: Add the locale keys**

In `engine/src/web/public/locales/en.json`, beside the other `skills.*` keys:

```json
  "skills.onDisk": "Skills in this project",
  "skills.onDiskWhy": "Every SKILL.md under .claude/skills/ in this checkout. A session can load these; whether mjloop routes work to one is a separate decision, shown per skill below.",
  "skills.onDiskNone": "This checkout has no .claude/skills/ directory, so it ships no skill of its own.",
  "skills.onDiskRouted": "Routed by mjloop to: {components}",
  "skills.onDiskUnrouted": "Present, and routed by nothing — mjloop never selects it. Accepting is a command: mjloop-cli skills accept.",
```

And the Arabic in `ar.json`, at the same keys:

```json
  "skills.onDisk": "مهارات هذا المشروع",
  "skills.onDiskWhy": "كل ملف SKILL.md تحت ‎.claude/skills/‎ في هذه النسخة. الجلسة تستطيع تحميلها، أمّا توجيه mjloop للعمل إلى إحداها فقرار منفصل يظهر بجانب كل مهارة أدناه.",
  "skills.onDiskNone": "لا يحتوي هذا المشروع على مجلّد ‎.claude/skills/‎، فهو لا يقدّم مهارةً خاصةً به.",
  "skills.onDiskRouted": "‏mjloop يوجّهها إلى: {components}",
  "skills.onDiskUnrouted": "موجودة، ولا يوجّهها شيء — لن يختارها mjloop أبداً. القبول أمرٌ يُنفَّذ: mjloop-cli skills accept.",
```

- [ ] **Step 5: Draw them**

In `engine/src/web/public/panels/skills.js`, add the typedef beside the others:

```js
/** @typedef {import('../../../schemas/project-skills.js').ProjectSkillOnDisk} ProjectSkillOnDisk */
```

Add the exported join, beside `joinAcceptances`:

```js
/**
 * Pair every skill on disk with the acceptance that routes it, or with null.
 *
 * The null is the interesting half here, exactly as in `joinAcceptances`: a
 * `SKILL.md` sitting in `.claude/skills/` that no acceptance names is a skill
 * the session can load and mjloop will never select. Neither list says that
 * on its own, and `readSkillsView` serves both in one document so the join
 * costs no second request.
 *
 * @param {SkillsView | null} view
 * @returns {{ skill: ProjectSkillOnDisk, routedBy: ProjectSkillAcceptance | null }[]}
 */
export function routeOnDisk(view) {
  if (view === null) return []
  const byId = new Map(view.acceptances.map((acceptance) => [acceptance.skillId, acceptance]))
  return view.onDisk.map((skill) => ({ skill, routedBy: byId.get(skill.name) ?? null }))
}
```

Inside `mountSkills()`, add the three hosts beside the others:

```js
  const onDiskEmpty = pick('skills-ondisk-empty')
  const onDiskHost = pick('skills-ondisk')
  const onDiskUnreadableHost = pick('skills-ondisk-unreadable')
```

In the `update(state)` body, after the `joined` block and before the `packages` block:

```js
      const onDisk = routeOnDisk(view)
      // "No skills here" is claimed only once the answer is in — the same rule
      // the acceptances list above follows.
      flag(onDiskEmpty, 'hidden', view === null || onDisk.length > 0)
      phrase(onDiskEmpty, 'skills.onDiskNone')
      reconcile(onDiskHost, onDisk, (entry) => entry.skill.path, projectSkillCard)
      reconcile(
        onDiskUnreadableHost,
        view?.onDiskUnreadable ?? [],
        (entry) => entry.path,
        projectSkillUnreadableRow,
      )
```

And the two row factories, beside the others:

```js
  function projectSkillCard() {
    const { root, slots } = clone('tpl-project-skill')
    return {
      root,
      /** @param {{ skill: ProjectSkillOnDisk, routedBy: ProjectSkillAcceptance | null }} entry */
      update(entry) {
        const name = slots['name']
        if (name !== undefined) verbatim(name, entry.skill.name)
        const description = slots['description']
        if (description !== undefined) verbatim(description, entry.skill.description)
        const at = slots['path']
        if (at !== undefined) verbatim(at, entry.skill.path)

        const routing = slots['routing']
        if (routing !== undefined) {
          // The one sentence neither list can produce alone. An acceptance
          // reaching no component routes nothing, whatever else it says, so
          // that case is drawn as unrouted rather than as a blank list.
          const components = entry.routedBy?.components ?? []
          if (components.length === 0) phrase(routing, 'skills.onDiskUnrouted')
          else phrase(routing, 'skills.onDiskRouted', { components: components.join(' ') })
        }

        translateStatic(root)
      },
    }
  }

  function projectSkillUnreadableRow() {
    const { root, slots } = clone('tpl-project-skill-unreadable')
    return {
      root,
      /** @param {SkillsView['onDiskUnreadable'][number]} entry */
      update(entry) {
        const at = slots['path']
        if (at !== undefined) verbatim(at, entry.path)
        // The walk's own diagnosis, engine-authored, kept verbatim — the same
        // position `unreadableRow` takes on the library's.
        const reason = slots['reason']
        if (reason !== undefined) verbatim(reason, entry.reason)
      },
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/web/ && npm run typecheck`
Expected: PASS. `tests/web/discipline.test.ts` also asserts every declared template is cloned and every cloned template is declared — both new templates are cloned above, so it stays green. `tests/web/locales.test.ts` asserts en/ar parity for the five new keys.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/web/public/index.html engine/src/web/public/panels/skills.js engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json engine/tests/web/panels.test.ts
git commit -m "feat(web): the Skills page shows the skills the project actually has"
```

---

### Task 4: A skills.sh connector, refusing honestly without a token

**Files:**
- Modify: `engine/src/schemas/config.ts` (`SkillSourceSchema` at :376)
- Modify: `engine/src/ops/skill-discovery.ts`
- Test: `engine/tests/ops/skills-sh-discovery.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `MAX_CANDIDATES`, `SkillCandidateSchema` — all already in `skill-discovery.ts`.
- Produces: `SkillsShTokenMissingError`, an optional `env` field on `SkillDiscoveryDeps`, and `'skills-sh'` as a `SkillSource`. Tasks 5 and 6 depend on all three names.

**Verified facts this task is built on** (probed 2026-08-02): the endpoint is `GET https://skills.sh/api/v1/skills/search?q=<query>&limit=<n>` (`q` minimum 2 characters, `limit` 1–200); it answers `401 {"error":"authentication_required","message":"…Pass a Vercel OIDC token (Authorization: Bearer <VERCEL_OIDC_TOKEN>)…"}` without one; the documented item fields are `id`, `slug`, `name`, `source`, `installs`, `sourceType`, `installUrl`, `url`, and the envelope is `{ "data": [...], "query", "searchType", "count", "durationMs" }`. **A description field is not documented**, and the response could not be observed without a token — so the mapping below tolerates its absence and Task 5's step 4 checks the real shape once a token exists.

- [ ] **Step 1: Write the failing test**

Create `engine/tests/ops/skills-sh-discovery.test.ts`:

```ts
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverCandidates, SkillsShTokenMissingError, SkillSourceDisabledError } from '../../src/ops/skill-discovery.js'
import { makeTempProject } from '../helpers/tmp-project.js'

/** A project whose config allows exactly the sources named. */
async function projectAllowing(sources: string[]): Promise<string> {
  const dir = await makeTempProject()
  const config = path.join(dir, '.mjloop', 'config.yaml')
  const raw = await fs.readFile(config, 'utf8')
  await fs.writeFile(
    config,
    `${raw}\norchestration:\n  skills:\n    sources: [${sources.join(', ')}]\n`,
    'utf8',
  )
  return dir
}

const body = {
  data: [
    { id: 1, slug: 'find-skills', name: 'find-skills', source: 'vercel-labs/skills', installs: 2800000,
      sourceType: 'github', installUrl: 'https://skills.sh/install/vercel-labs/skills/find-skills',
      url: '/vercel-labs/skills/find-skills' },
    { id: 2, slug: 'lark-approval', name: 'lark-approval', source: 'site/open.feishu.cn', installs: 12,
      sourceType: 'site', installUrl: 'https://skills.sh/install/site/open.feishu.cn/lark-approval',
      url: 'https://skills.sh/site/open.feishu.cn/lark-approval' },
  ],
  query: 'skills', searchType: 'name', count: 2, durationMs: 4,
}

const answer = (payload: unknown, url: string) =>
  Object.assign(new Response(JSON.stringify(payload), { status: 200 }), { url }) as Response

describe('the skills.sh connector', () => {
  it('refuses before any request when the project has not allowed the source', async () => {
    const dir = await projectAllowing(['github'])
    let called = 0
    const fetch = (async () => { called += 1; return new Response('{}') }) as unknown as typeof globalThis.fetch
    await expect(discoverCandidates(dir, { query: 'react', source: 'skills-sh' }, { fetch }))
      .rejects.toBeInstanceOf(SkillSourceDisabledError)
    expect(called).toBe(0)
  })

  it('refuses by name when no token is set, rather than reporting no results', async () => {
    const dir = await projectAllowing(['skills-sh'])
    let called = 0
    const fetch = (async () => { called += 1; return new Response('{}') }) as unknown as typeof globalThis.fetch
    await expect(discoverCandidates(dir, { query: 'react', source: 'skills-sh' }, { fetch, env: {} }))
      .rejects.toBeInstanceOf(SkillsShTokenMissingError)
    expect(called).toBe(0)
  })

  it('sends the token as a bearer header and maps the response to candidates', async () => {
    const dir = await projectAllowing(['skills-sh'])
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return answer(body, url)
    }) as unknown as typeof globalThis.fetch

    const candidates = await discoverCandidates(
      dir, { query: 'skills', source: 'skills-sh' }, { fetch, env: { SKILLS_SH_TOKEN: 'tok' } },
    )

    expect(seen[0]?.url).toBe('https://skills.sh/api/v1/skills/search?q=skills&limit=20')
    const headers = seen[0]?.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(seen[0]?.init?.redirect).toBe('manual')

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      source: 'skills-sh',
      url: 'https://skills.sh/vercel-labs/skills/find-skills',
      repository: 'vercel-labs/skills',
      ref: 'HEAD',
      skillName: 'find-skills',
    })
    expect(candidates[0]?.description).toContain('2800000')
    // Already absolute, and left alone.
    expect(candidates[1]?.url).toBe('https://skills.sh/site/open.feishu.cn/lark-approval')
  })

  it('accepts VERCEL_OIDC_TOKEN as well as SKILLS_SH_TOKEN', async () => {
    const dir = await projectAllowing(['skills-sh'])
    const fetch = (async (url: string) => answer({ data: [] }, url)) as unknown as typeof globalThis.fetch
    await expect(
      discoverCandidates(dir, { query: 'react', source: 'skills-sh' }, { fetch, env: { VERCEL_OIDC_TOKEN: 'tok' } }),
    ).resolves.toEqual([])
  })

  it('drops an item it cannot turn into a candidate rather than failing the search', async () => {
    const dir = await projectAllowing(['skills-sh'])
    const payload = { data: [{ slug: 'ok', source: 'a/b', url: '/a/b/ok' }, { slug: 'broken' }, 'not an object'] }
    const fetch = (async (url: string) => answer(payload, url)) as unknown as typeof globalThis.fetch
    const candidates = await discoverCandidates(
      dir, { query: 'x', source: 'skills-sh' }, { fetch, env: { SKILLS_SH_TOKEN: 'tok' } },
    )
    expect(candidates.map((candidate) => candidate.skillName)).toEqual(['ok'])
  })
})
```

The config-appending helper assumes `makeTempProject` writes a `.mjloop/config.yaml` with no `orchestration:` key. Check that assumption before running; if the fixture already has an `orchestration:` block, rewrite the helper to parse the YAML with the `yaml` package (already a devDependency), set `orchestration.skills.sources`, and write it back.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/ops/skills-sh-discovery.test.ts`
Expected: FAIL — `SkillsShTokenMissingError` is not exported, and `'skills-sh'` is not a valid `SkillSource`.

- [ ] **Step 3: Add the source to the config enum**

In `engine/src/schemas/config.ts`, replace the `SkillSourceSchema` line:

```ts
/**
 * Where a skill this project does not already have may be discovered from.
 *
 * `skills-sh` is the agent-skills directory at https://skills.sh. It is in
 * this enum and *not* in `sources`' default for the same reason `web` is not:
 * a source is a place this project will fetch instructions from, and adding
 * one is the project's decision to make in its own config. Its API also
 * requires a token, which `ops/skill-discovery.ts` refuses by name rather
 * than reporting as an empty result.
 */
export const SkillSourceSchema = z.enum(['github', 'registry', 'web', 'skills-sh'])
```

Leave `sources: z.array(SkillSourceSchema).default(['github'])` exactly as it is.

- [ ] **Step 4: Write the connector**

In `engine/src/ops/skill-discovery.ts`, widen the deps interface:

```ts
export interface SkillDiscoveryDeps {
  fetch: typeof globalThis.fetch
  /**
   * Optional, and read rather than defaulted at construction, so an existing
   * caller passing `{ fetch }` keeps type-checking untouched. The one thing
   * read from it is a skills.sh token; nothing here reads the ambient
   * environment for anything else.
   */
  env?: Record<string, string | undefined>
}
```

Add the error, beside `WebSearchUnavailableError`:

```ts
/** skills.sh answers 401 without a Vercel OIDC token, and this build has not been given one. */
export class SkillsShTokenMissingError extends Error {
  constructor() {
    super(
      'searching skills.sh needs a Vercel OIDC token, and neither SKILLS_SH_TOKEN nor VERCEL_OIDC_TOKEN is set — ' +
        'https://skills.sh/api/v1/ answers 401 "authentication_required" without one. Set one of the two in this ' +
        'shell (see https://skills.sh/docs/api#authentication), or search "github", which needs no token.',
    )
    this.name = 'SkillsShTokenMissingError'
  }
}
```

Add the connector, beside `searchGithub`:

```ts
const SKILLS_SH_ORIGIN = 'https://skills.sh'
const SKILLS_SH_SEARCH_URL = `${SKILLS_SH_ORIGIN}/api/v1/skills/search`

/**
 * skills.sh's own search index — data-only, like every connector here.
 *
 * Two shapes of dishonesty are deliberately avoided. First, a missing token
 * is a refusal and never an empty result: 401 means "we did not look", not
 * "there is nothing". Second, `installs` is *not* mapped onto `stars`. They
 * are different measurements and a candidate list that prints one under the
 * other's name is a lie a reviewer cannot see; the count goes into the
 * description sentence instead, attributed.
 */
async function searchSkillsSh(query: string, deps: SkillDiscoveryDeps): Promise<SkillCandidate[]> {
  const env = deps.env ?? process.env
  const token = env['SKILLS_SH_TOKEN'] ?? env['VERCEL_OIDC_TOKEN'] ?? null
  if (token === null || token.length === 0) throw new SkillsShTokenMissingError()

  const url = `${SKILLS_SH_SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${MAX_CANDIDATES}`
  const body = await fetchJson(url, deps, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'mjloop-skill-discovery',
    },
  })
  const items = isRecord(body) && Array.isArray(body.data) ? body.data : []

  const candidates: SkillCandidate[] = []
  for (const item of items.slice(0, MAX_CANDIDATES)) {
    if (!isRecord(item)) continue
    const slug = typeof item.slug === 'string' ? item.slug : typeof item.name === 'string' ? item.name : null
    const repository = typeof item.source === 'string' ? item.source : null
    const href = typeof item.url === 'string' ? item.url : null
    if (slug === null || repository === null || href === null) continue

    // A relative `url` is what the directory serves for a skill page; an
    // absolute one is passed through untouched. Anything else fails
    // `SkillCandidateSchema`'s https check below and is dropped rather than
    // guessed at.
    const absolute = href.startsWith('/') ? `${SKILLS_SH_ORIGIN}${href}` : href

    const installs = typeof item.installs === 'number' ? item.installs : null
    const described =
      typeof item.description === 'string' && item.description.length > 0
        ? item.description
        : installs === null
          ? 'No description in the skills.sh search index — open the candidate page before importing it.'
          : `No description in the skills.sh search index; ${installs} installs reported. Open the candidate page before importing it.`

    const parsed = SkillCandidateSchema.safeParse({
      source: 'skills-sh',
      url: absolute,
      repository,
      // The index reports no ref. `HEAD` is the honest placeholder: a
      // candidate makes no immutability promise anyway, and `inspectCandidate`
      // is what resolves a ref to a pinned sha before fetching anything.
      ref: 'HEAD',
      skillName: slug,
      description: described,
    })
    if (parsed.success) candidates.push(parsed.data)
  }
  return candidates
}
```

Add the branch to `discoverCandidates`'s switch, before `case 'web'`:

```ts
    case 'skills-sh':
      return searchSkillsSh(options.query, deps)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/ops/ && npm run typecheck`
Expected: PASS. If `tsc` reports a non-exhaustive switch anywhere else over `SkillSource`, add the `'skills-sh'` branch there too — that error is the enum change doing its job.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/schemas/config.ts engine/src/ops/skill-discovery.ts engine/tests/ops/skills-sh-discovery.test.ts
git commit -m "feat(skills): search skills.sh, and refuse by name without a token"
```

---

### Task 5: Reach the new source from the CLI

**Files:**
- Modify: `engine/src/cli/index.ts` (the help text at :89, `skillsSearchCommand` at ~:1418)
- Test: `engine/tests/cli/index.test.ts`

**Interfaces:**
- Consumes: `discoverCandidates` and `SkillSourceSchema`, both already imported there.
- Produces: nothing new; this task only widens two strings and one refusal.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/cli/index.test.ts`, beside the existing `skills search` tests (search the file for `skills search` and match its idiom for invoking the CLI and injecting `deps.fetch`):

```ts
  it('names skills-sh in the --source refusal', async () => {
    const dir = await makeTempProject()
    const result = await run(['skills', 'search', 'react', '--source', 'nonsense', '--dir', dir])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('skills-sh')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/cli/index.test.ts`
Expected: FAIL — the message reads `--source takes github, registry or web`.

- [ ] **Step 3: Widen the two strings**

In `engine/src/cli/index.ts`, in `skillsSearchCommand`, replace the usage line and the refusal:

```ts
    return fail('skills search needs a query: mjloop-cli skills search <query> [--source github|registry|web|skills-sh] [--dir <path>]')
```

```ts
    if (!result.success) return fail(`--source takes github, registry, web or skills-sh — got "${source}"`)
```

And in the help block at :89, update the `skills search` line to the same four-value form. Search the help text for `--source` and change every occurrence.

- [ ] **Step 4: Check the real response shape, once, against a token**

This is the one step in this plan that cannot be done from a test fixture, and it is why Task 4's mapping is written to tolerate a missing `description`.

```bash
cd /Volumes/SSD/Projects/loop/engine
# Only if a token is available. Without one this prints the 401 the connector already refuses on.
SKILLS_SH_TOKEN="$SKILLS_SH_TOKEN" node dist/cli/index.js skills search react --source skills-sh --json --dir /path/to/a/project/allowing/skills-sh
```

If the real items carry a `description` field, nothing changes — the mapping already prefers it. If they carry a field this mapping ignores that a reviewer would want (a `summary`, a `homepage`), add it to the fallback chain in `searchSkillsSh` and add a case to `tests/ops/skills-sh-discovery.test.ts` covering it. If no token is available, **say so in the commit message** rather than claiming the shape was verified.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/cli/ && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/cli/index.ts engine/tests/cli/index.test.ts
git commit -m "feat(cli): skills search --source skills-sh"
```

---

### Task 6: One read route for search

**Files:**
- Modify: `engine/src/web/api.ts` (the `case 'skills'` at :258)
- Modify: `engine/src/web/codes.ts`
- Modify: `engine/src/web/public/locales/en.json`, `ar.json`
- Test: `engine/tests/web/api.test.ts`

**Interfaces:**
- Consumes: `discoverCandidates` and the three discovery errors from `ops/skill-discovery.ts`; `SkillSourceSchema` from `schemas/config.ts`.
- Produces: `GET /api/skills/search?q=<query>&source=<source>` answering `{ candidates: SkillCandidate[] }`. Task 7 fetches exactly this.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/web/api.test.ts`, matching the file's existing idiom for calling `handleApi`:

```ts
describe('GET /api/skills/search', () => {
  it('is a 400 without a query of at least two characters', async () => {
    const dir = await makeTempProject()
    for (const path of ['/api/skills/search', '/api/skills/search?q=', '/api/skills/search?q=a']) {
      const result = await handleApi(dir, 'GET', path)
      expect(result?.status, path).toBe(400)
    }
  })

  it('is a 400 for a source that is not in the enum', async () => {
    const dir = await makeTempProject()
    const result = await handleApi(dir, 'GET', '/api/skills/search?q=react&source=nonsense')
    expect(result?.status).toBe(400)
  })

  it('answers a code, never a sentence, when the project has not allowed the source', async () => {
    const dir = await makeTempProject()
    const result = await handleApi(dir, 'GET', '/api/skills/search?q=react&source=skills-sh')
    expect(result?.status).toBe(409)
    expect(result?.body).toEqual({ error: { code: 'error.skillSourceDisabled' } })
  })

  it('stays a 405 for a POST', async () => {
    const dir = await makeTempProject()
    const result = await handleApi(dir, 'POST', '/api/skills/search?q=react')
    expect(result?.status).toBe(405)
  })
})
```

Adjust `result?.status` / `result?.body` to whatever `ApiResult` actually names its fields — read the `ok()` and `fail()` helpers at the top of `api.ts` first.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/web/api.test.ts`
Expected: FAIL — every case answers 404, because `case 'skills'` still requires `segments.length === 1`.

- [ ] **Step 3: Add the codes**

In `engine/src/web/codes.ts`, add to `WEB_CODES`, in the read-api group:

```ts
  /* discovery's three refusals. Each is a *policy* answer rather than a fault —
     the project has not allowed this source, this machine has no token for it,
     or this build has no provider — and each needs a different next step, so
     they are three codes and not one. No `params`: the sentence lives in the
     locale files, like every other. */
  'error.skillSourceDisabled',
  'error.skillsShTokenMissing',
  'error.webSearchUnavailable',
```

In `en.json`:

```json
  "error.skillSourceDisabled": "This project has not allowed that skill source. Add it to orchestration.skills.sources in .mjloop/config.yaml first.",
  "error.skillsShTokenMissing": "Searching skills.sh needs a Vercel OIDC token. Set SKILLS_SH_TOKEN or VERCEL_OIDC_TOKEN in the shell the cockpit was started from, then restart it.",
  "error.webSearchUnavailable": "This build has no general web search provider. Search github or skills.sh instead.",
```

In `ar.json`:

```json
  "error.skillSourceDisabled": "لم يسمح هذا المشروع بهذا المصدر للمهارات. أضِفه إلى orchestration.skills.sources في ‎.mjloop/config.yaml‎ أولاً.",
  "error.skillsShTokenMissing": "البحث في skills.sh يحتاج رمز Vercel OIDC. عيّن SKILLS_SH_TOKEN أو VERCEL_OIDC_TOKEN في الصدفة التي شُغّل منها الـ cockpit ثم أعِد تشغيله.",
  "error.webSearchUnavailable": "لا يحتوي هذا الإصدار على مزوّد بحث عام على الويب. ابحث في github أو skills.sh بدلاً من ذلك.",
```

- [ ] **Step 4: Add the route**

In `engine/src/web/api.ts`, add the imports:

```ts
import {
  discoverCandidates,
  SkillsShTokenMissingError,
  SkillSourceDisabledError,
  WebSearchUnavailableError,
} from '../ops/skill-discovery.js'
import { SkillSourceSchema } from '../schemas/config.js'
```

Replace the `case 'skills'` block, keeping its existing comment and adding to it:

```ts
    case 'skills':
      // Still no parameter that *activates* anything, and none a later story
      // should add: accepting a skill changes what every later run is told,
      // and that is the class of write `web/writes.ts`'s header permanently
      // denies the browser. `mjloop-cli skills accept|disable|enable|remove`
      // is where that decision is made.
      if (segments.length === 1) return ok(await readSkillsView(projectDir))

      // `search` is the one sub-route, and it is a read: it returns search
      // *results* and writes nothing anywhere. The three refusals below are
      // policy answers rather than faults, so each gets its own code — a
      // disabled source, a missing token and an unwired provider need three
      // different next steps from the person reading the screen.
      if (segments.length === 2 && first === 'search') {
        const q = query.get('q') ?? ''
        if (q.length < 2) return fail(400, 'error.badRequest')
        const source = SkillSourceSchema.safeParse(query.get('source') ?? 'github')
        if (!source.success) return fail(400, 'error.badRequest')
        try {
          return ok({ candidates: await discoverCandidates(projectDir, { query: q, source: source.data }) })
        } catch (error) {
          if (error instanceof SkillSourceDisabledError) return fail(409, 'error.skillSourceDisabled')
          if (error instanceof SkillsShTokenMissingError) return fail(409, 'error.skillsShTokenMissing')
          if (error instanceof WebSearchUnavailableError) return fail(409, 'error.webSearchUnavailable')
          throw error
        }
      }
      break
```

`discoverCandidates` is called without a `deps` argument on purpose: its default is `globalThis.fetch` and `process.env`, which is what the server should use. Anything thrown that is not one of the three named refusals falls through to `handleApi`'s catch, which writes the diagnosis to the server's own stderr and answers `error.unreadable` — the existing contract.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine && npx vitest run tests/web/ && npm run typecheck`
Expected: PASS. `tests/web/locales.test.ts` asserts each new `WEB_CODES` entry has an `en.json` key; the three above satisfy it.

- [ ] **Step 6: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/web/api.ts engine/src/web/codes.ts engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json engine/tests/web/api.test.ts
git commit -m "feat(web): a read route for skill discovery"
```

---

### Task 7: A search box on the Skills panel

**Files:**
- Modify: `engine/src/web/public/index.html` (`#panel-skills`, and the template block)
- Modify: `engine/src/web/public/panels/skills.js`
- Modify: `engine/src/web/public/app.js`
- Modify: `engine/src/web/public/locales/en.json`, `ar.json`
- Test: `engine/tests/web/panels.test.ts`

**Interfaces:**
- Consumes: `GET /api/skills/search` from Task 6, via `get(path)` from `lib/api.js` (returns `{ ok: true, body } | { ok: false, code }`).
- Produces: `searchSkills()` — exported from `panels/skills.js`, registered in `app.js` as the `skills-search` action.

- [ ] **Step 1: Write the failing test**

Add to `engine/tests/web/panels.test.ts`:

```ts
describe('searching for a skill from the cockpit', () => {
  it('sends the query and the source, and draws each candidate', async () => {
    const page = await loadPage()
    mountSkills()

    const asked: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (at: string) => {
      asked.push(String(at))
      return new Response(
        JSON.stringify({
          candidates: [
            { source: 'skills-sh', url: 'https://skills.sh/a/b/c', repository: 'a/b', ref: 'HEAD',
              skillName: 'c', description: 'Use when c.' },
          ],
        }),
        { status: 200 },
      )
    }) as never)

    const input = /** @type {HTMLInputElement} */ (document.getElementById('skills-search-q'))
    input.value = 'react'
    document.getElementById('skills-search-source')?.dispatchEvent(new Event('change'))

    await searchSkills()

    expect(asked[0]).toContain('/api/skills/search?q=react')
    expect(document.getElementById('skills-search-results')?.textContent).toContain('a/b')
    expect(document.getElementById('skills-search-results')?.textContent).toContain('Use when c.')
    void page
  })

  it('shows the refusal code as a sentence, and draws no results', async () => {
    await loadPage()
    mountSkills()
    vi.spyOn(globalThis, 'fetch').mockImplementation((async () =>
      new Response(JSON.stringify({ error: { code: 'error.skillsShTokenMissing' } }), { status: 409 })) as never)

    const input = /** @type {HTMLInputElement} */ (document.getElementById('skills-search-q'))
    input.value = 'react'
    await searchSkills()

    expect(document.getElementById('skills-search-error')?.hidden).toBe(false)
    expect(document.getElementById('skills-search-results')?.children.length).toBe(0)
  })

  it('asks nothing at all for a query under two characters', async () => {
    await loadPage()
    mountSkills()
    const fetch = vi.spyOn(globalThis, 'fetch')
    const input = /** @type {HTMLInputElement} */ (document.getElementById('skills-search-q'))
    input.value = 'a'
    await searchSkills()
    expect(fetch).not.toHaveBeenCalled()
  })
})
```

Match `loadPage()`'s real signature and the file's existing way of installing the locale and the api token (`installToken`) — copy it from a neighbouring test in the same file rather than inventing it.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && npx vitest run tests/web/panels.test.ts`
Expected: FAIL — `searchSkills is not a function`.

- [ ] **Step 3: Add the markup**

In `index.html`, add this block to `#panel-skills`, **after** the `skills.onDisk` block from Task 3:

```html
        <section class="block">
          <h2 data-i18n="skills.search"></h2>
          <p class="hint" data-i18n="skills.searchWhy"></p>
          <form id="skills-search" data-act="skills-search">
            <label for="skills-search-q" data-i18n="skills.searchQuery"></label>
            <input id="skills-search-q" name="q" type="search" autocomplete="off" />
            <label for="skills-search-source" data-i18n="skills.searchSource"></label>
            <select id="skills-search-source" name="source">
              <option value="github">github</option>
              <option value="skills-sh">skills.sh</option>
              <option value="registry">registry</option>
              <option value="web">web</option>
            </select>
            <button type="submit" data-i18n="skills.searchGo"></button>
          </form>
          <p class="banner warn" id="skills-search-error" hidden></p>
          <p class="empty" id="skills-search-empty" hidden></p>
          <div id="skills-search-results"></div>
        </section>
```

And the result template, beside the others:

```html
    <template id="tpl-candidate">
      <article class="card">
        <h3 data-slot="skillName"></h3>
        <p data-slot="description"></p>
        <p class="record"><span data-slot="repository"></span> · <span data-slot="source"></span></p>
        <p class="hint" data-slot="next"></p>
      </article>
    </template>
```

The form carries `data-act` and the button does not: `ui/bus.js` dispatches a form on **submit** only, and explicitly ignores a click that resolves to a form — which is what stops the search firing twice.

- [ ] **Step 4: Add the locale keys**

`en.json`:

```json
  "skills.search": "Find a skill",
  "skills.searchWhy": "Search a source this project has allowed. Results are metadata only — nothing is downloaded, nothing is written, and none of these is active. Importing one is a command: mjloop-cli skills inspect, then mjloop-cli skills import.",
  "skills.searchQuery": "Query",
  "skills.searchSource": "Source",
  "skills.searchGo": "Search",
  "skills.searchNone": "No candidate matched that query on that source.",
  "skills.searchNext": "Look before importing: mjloop-cli skills inspect {url}",
```

`ar.json`:

```json
  "skills.search": "ابحث عن مهارة",
  "skills.searchWhy": "ابحث في مصدرٍ سمح به هذا المشروع. النتائج بيانات وصفية فقط — لا يُنزَّل شيء، ولا يُكتب شيء، ولا شيء منها مُفعَّل. الاستيراد أمرٌ يُنفَّذ: mjloop-cli skills inspect ثم mjloop-cli skills import.",
  "skills.searchQuery": "الاستعلام",
  "skills.searchSource": "المصدر",
  "skills.searchGo": "ابحث",
  "skills.searchNone": "لا مرشّح يطابق هذا الاستعلام في هذا المصدر.",
  "skills.searchNext": "افحصها قبل استيرادها: mjloop-cli skills inspect {url}",
```

- [ ] **Step 5: Run the search**

In `panels/skills.js`, add the import:

```js
import { feed, get } from '../lib/api.js'
```

(replacing the existing `import { feed } from '../lib/api.js'`), and add module-level state plus the exported action. It sits outside `mountSkills()` because `bus.on` registers by name once, and because the test calls it directly:

```js
/** @typedef {import('../../../schemas/skill-import.js').SkillCandidate} SkillCandidate */

/**
 * The last search's answer, held here rather than in a `feed`.
 *
 * A `feed` re-fetches when a revision moves, which is right for a document
 * that describes the project and wrong for this: a search is a question a
 * person asked once, and re-asking it every time `.mjloop/` changes would
 * turn one keystroke into an unbounded stream of outbound requests.
 *
 * @type {{ candidates: SkillCandidate[], code: string | null, asked: boolean }}
 */
const search = { candidates: [], code: null, asked: false }

/**
 * Run the search the form is holding. Exported so `app.js` can register it as
 * the `skills-search` action and so the panel test can await it.
 *
 * @returns {Promise<void>}
 */
export async function searchSkills() {
  const q = /** @type {HTMLInputElement | null} */ (document.getElementById('skills-search-q'))?.value.trim() ?? ''
  const source = /** @type {HTMLSelectElement | null} */ (document.getElementById('skills-search-source'))?.value ?? 'github'
  // The same floor the route enforces, checked here so a one-character query
  // is a no-op rather than a round trip that comes back 400.
  if (q.length < 2) return

  const answer = await get(`/api/skills/search?q=${encodeURIComponent(q)}&source=${encodeURIComponent(source)}`)
  search.asked = true
  if (answer.ok) {
    search.candidates = Array.isArray(answer.body?.candidates) ? answer.body.candidates : []
    search.code = null
  } else {
    search.candidates = []
    search.code = answer.code
  }
  draw()
}
```

Inside `mountSkills()`, add the hosts and draw them from `update(state)`:

```js
  const searchError = pick('skills-search-error')
  const searchEmpty = pick('skills-search-empty')
  const searchResults = pick('skills-search-results')
```

and, at the end of `update(state)`:

```js
      // Nothing is claimed before a question was asked: an empty result line
      // on first paint would answer a query nobody typed.
      flag(searchError, 'hidden', search.code === null)
      if (search.code !== null) phrase(searchError, search.code)
      flag(searchEmpty, 'hidden', !search.asked || search.code !== null || search.candidates.length > 0)
      if (search.asked) phrase(searchEmpty, 'skills.searchNone')
      reconcile(searchResults, search.candidates, (candidate) => candidate.url, candidateCard)
```

and the row factory:

```js
  function candidateCard() {
    const { root, slots } = clone('tpl-candidate')
    return {
      root,
      /** @param {SkillCandidate} candidate */
      update(candidate) {
        const skillName = slots['skillName']
        if (skillName !== undefined) verbatim(skillName, candidate.skillName)
        const description = slots['description']
        if (description !== undefined) verbatim(description, candidate.description)
        const repository = slots['repository']
        if (repository !== undefined) verbatim(repository, candidate.repository)
        const source = slots['source']
        if (source !== undefined) verbatim(source, candidate.source)
        // The next step, spelled out. A result with no way forward reads as a
        // button somebody forgot to wire up; the way forward is a command,
        // because importing executes a package's smoke checks.
        const next = slots['next']
        if (next !== undefined) phrase(next, 'skills.searchNext', { url: candidate.url })

        translateStatic(root)
      },
    }
  }
```

- [ ] **Step 6: Register the action**

In `engine/src/web/public/app.js`, beside the other `bus.on` registrations (~:180), add the import and the handler:

```js
import { searchSkills } from './panels/skills.js'
```

```js
bus.on('skills-search', () => void searchSkills())
```

If `app.js` already imports from `./panels/skills.js`, extend that import rather than adding a second one.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS, whole suite. Three discipline assertions are load-bearing here and should all stay green: every `data-act` is registered (`skills-search` now is), every declared template is cloned (`tpl-candidate` is), and `.value` is only ever *read* on a control, never assigned — `searchSkills` reads `input.value` and assigns nothing.

- [ ] **Step 8: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add engine/src/web/public/index.html engine/src/web/public/panels/skills.js engine/src/web/public/app.js engine/src/web/public/locales/en.json engine/src/web/public/locales/ar.json engine/tests/web/panels.test.ts
git commit -m "feat(web): search for a skill from the cockpit"
```

---

### Task 8: Say so in the docs

**Files:**
- Modify: `docs/usage.md`
- Modify: `docs/usage.ar.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Find the section that describes the Skills page and the skills commands**

Run: `cd /Volumes/SSD/Projects/loop && grep -n "skills" docs/usage.md`

- [ ] **Step 2: Write the three facts a reader needs**

Add to `docs/usage.md`, in that section:

```markdown
The Skills page answers four questions, in order: what this project is made of
(the component map), **what skills this checkout holds** (`.claude/skills/`, read
straight off disk, each one marked with whether mjloop routes work to it),
what this project has accepted, and what this machine's library holds. A skill
can be present and unrouted — that is a normal state, and the page says which.

To find a new one, use the search box on that page, or:

    mjloop-cli skills search <query> --source github|registry|web|skills-sh

`skills-sh` searches <https://skills.sh>. Two things it needs first:

1. The project must allow it — add `skills-sh` to `orchestration.skills.sources`
   in `.mjloop/config.yaml`. The default is `[github]` and no source is ever
   enabled on a project's behalf.
2. Its API requires a Vercel OIDC token. Set `SKILLS_SH_TOKEN` or
   `VERCEL_OIDC_TOKEN` in the shell (see <https://skills.sh/docs/api>). Without
   one, the search refuses and says so — it never reports an empty result for a
   missing token. The cockpit reads the environment of the shell it was started
   from, so set the variable before `/mjloop:web`.

Search is metadata only. Nothing is downloaded and nothing is activated by it —
`mjloop-cli skills inspect <url>` looks at a candidate, and `mjloop-cli skills
import <url>` is what writes one into the library after a passed audit.
```

- [ ] **Step 3: Translate it into `docs/usage.ar.md`**

Put it at the matching position, matching that file's existing register and its handling of Latin-script identifiers.

- [ ] **Step 4: Verify the whole thing once more**

Run: `cd engine && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/SSD/Projects/loop
git add docs/usage.md docs/usage.ar.md
git commit -m "docs: the Skills page, and searching skills.sh"
```

---

## Notes for the implementer

**What this plan deliberately does not do.**

- It does not import anything from the cockpit. `skills accept` and `skills import` stay commands, because both change what every later run is told and importing executes a package's declared smoke checks. `web/writes.ts`'s header is the boundary and this plan does not move it.
- It does not map skills.sh's `installs` onto `SkillCandidate.stars`. They are different measurements.
- It does not make `skills-sh` a default source, and does not touch `sources`' `['github']` default.
- It does not read `~/.claude/skills` or plugin skills. "The project's skills" means this checkout's `.claude/skills/`, which is what travels with the repository.

**One thing to watch.** A skills.sh candidate whose `source` is `site/<domain>` rather than `owner/repo` is not a GitHub repository, and `candidateFromUrl` in `cli/index.ts` parses GitHub URLs only — `skills inspect` on one will refuse by name. That refusal is correct and already worded; do not widen `candidateFromUrl` as part of this plan.
