# S05 — Dynamic skill selection for fixed agent roles

**Purpose:** Select accepted component skills for existing MjLoop roles and pin that decision to the run.

**Depends on:** S04.  
**Files owned:** Skill-selection schema/operation; run/contract changes; leader guidance; planner/builder/critic/verifier guidance; focused selection/run/contract/plugin tests.

## Required interface

```ts
interface SkillSelection {
  component: string
  agent: string
  skillIds: readonly string[]
  reasons: readonly string[]
  sourceBrief: { id: string; revision: number }
}
```

## Required work

1. Select from accepted project skills only, using the approved brief's component ids and declared tags.
2. Sort selections deterministically and include one reason for each selected skill.
3. Pin the resulting manifest before dispatch. An update to the shared library must not change a running task's context.
4. Add only the selected, bounded skill guidance to the existing agent brief. Keep agent role definitions unchanged.
5. Analyze multi-component work: parallelize only when component roots, declared interface set, and shared-resource set prove independence; otherwise use the project concurrency policy.
6. Render selection evidence in run maps/handoffs and read-only cockpit views.

## Required tests

- Flutter brief selects Flutter skills only; Next.js brief selects Next.js only; Python follows the same rule.
- Authentication boundary may select an accepted security skill in addition to component skills.
- Unaccepted, incompatible, and unrelated skills are rejected.
- Default ambiguity serializes work; proven independent branches may be parallel.

## Completion evidence

- Every selected skill is traceable to an approved brief, accepted profile, accepted package, and receiving agent.

## Stop conditions

- Do not create `flutter-builder`, `nextjs-builder`, or any permanent duplicate agent.
- Do not let a model add a skill id absent from the validated selection.
