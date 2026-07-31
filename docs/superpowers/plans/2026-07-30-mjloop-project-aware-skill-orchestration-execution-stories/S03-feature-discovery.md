# S03 — Feature Discovery skill

**Purpose:** Add the MjLoop adaptation of Grill Me as a discovery-only interview before planning.

**Depends on:** S02.  
**Files owned:**

- Create `skills/mjloop-feature-discovery/SKILL.md`
- Modify `commands/plan.md`, `skills/mjloop-leader/SKILL.md`
- Modify `README.md`, `docs/usage.md`, `docs/usage.ar.md`
- Create `engine/tests/plugin/feature-discovery-skill.test.ts`

## Required behavior

1. Read the accepted project profile, project contract, relevant documentation, and prior feature briefs before asking a user a question.
2. Ask exactly one judgment question per turn, wait for its answer, and include a recommendation.
3. Respect project modes: `always`, `ask`, and `off`; a recorded per-feature choice overrides the project default.
4. Output a draft feature-brief payload only. Do not select skills, create a plan, write a story, modify code, or dispatch an agent.
5. The leader may enter the normal plan track only after an approved brief when policy requires discovery.

## Required tests

- Assert the skill says to inspect discoverable facts rather than ask for them.
- Assert one-question behavior, recommendation requirement, no-execution boundary, and no-routing boundary.
- Assert documentation describes the same three modes in English and Arabic.

## Completion evidence

- A test can reject a future edit that permits the discovery skill to plan, route, or execute.
- `/mjloop:plan` has an explicit policy branch rather than an implicit model choice.

## Stop conditions

- Do not copy unrelated upstream workflow commands into MjLoop.
- Do not remove existing human plan approval or plan-track gates.
