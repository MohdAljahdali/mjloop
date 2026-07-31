# S02 — Project profile and project-scoped policy

**Purpose:** Introduce an accepted component map and project-owned orchestration settings before feature briefs reference components.

**Depends on:** S01.  
**Files owned:**

- Create `engine/src/schemas/project-profile.ts`
- Create `engine/src/ops/project-profile.ts`
- Create `engine/src/store/project-profile-store.ts`
- Modify `engine/src/ops/init.ts`, `engine/src/schemas/config.ts`, `engine/src/store/config-mutation.ts`
- Create `commands/config.md`
- Modify the existing Config web panel, API/read/write boundaries, and English/Arabic locales as listed in the master plan.
- Create focused schema, detector, config-mutation, and panel tests.

## Required interfaces

```ts
type ComponentTechnology = 'flutter' | 'nextjs' | 'python' | 'unknown'
type UncertainConcurrency = 'sequential' | 'ask' | 'parallel'

interface ProjectComponent {
  id: string
  root: string
  technology: ComponentTechnology
  verification: { test: string | null; lint: string | null; build: string | null }
  skillTags: readonly string[]
}
```

## Required work

1. Write fixtures for standalone Flutter, Next.js, Python, mixed-component, nested-manifest, and unknown projects.
2. Implement a read-only detector: Flutter comes from `pubspec.yaml`; Next.js from a package manifest plus framework dependency; Python from `pyproject.toml` or equivalent declared metadata. Never infer technology from a directory name.
3. Persist a proposed profile separately from an accepted profile. A scan may propose a revision but may not silently activate it.
4. Add defaulted, additive project settings for discovery mode, question budget, completion mode, execution mode, repair attempts, independent-review policy, source/update policy, and uncertain concurrency.
5. Make `sequential` the default whenever component independence is not proven.
6. Add `/mjloop:config`; it must use the same guarded config mutation behavior as the web panel and never hand-edit YAML.

## Required tests

- Existing config tests prove old config files still parse with new defaults.
- Detector tests prove no writes occur.
- Config mutation and web panel tests prove stale writes fail.
- Mixed fixture tests prove component ids and roots are stable and relative to the project root.

## Completion evidence

- Focused tests pass.
- An existing `.mjloop/config.yaml` without new keys remains valid.
- A mixed project can hold an accepted Flutter and Next.js component map without enabling any skill.

## Stop conditions

- Do not invent support for an unrecognized framework; emit `unknown`.
- Do not let the browser write a profile, start a run, or bypass compare-and-swap validation.
