# S04 — Immutable feature briefs

**Purpose:** Store discovery decisions as engine-owned, versioned records that planning can trust.

**Depends on:** S03.  
**Files owned:** Feature schema/store/path modules; narrowly scoped MCP operations; feature read/approval web route; schema/store/MCP/web-boundary tests named in the master plan.

## Required interface

```ts
type FeatureBriefStatus = 'draft' | 'approved' | 'superseded'

interface FeatureBrief {
  id: string
  revision: number
  title: string
  status: FeatureBriefStatus
  problem: string
  decisions: readonly Decision[]
  acceptance: readonly string[]
  affectedComponents: readonly string[]
  discovery: { mode: 'always' | 'ask' | 'off'; questionBudget: number; completedAt: string | null }
  supersedes: { id: string; revision: number } | null
}
```

## Required work

1. Add validated paths under `.mjloop/features/` using existing atomic-write and lock conventions.
2. Validate safe ids, bounded question budgets, nonempty acceptance criteria, and affected component ids from the accepted profile.
3. Expose only create/read/append-decision/approve/supersede operations through the engine/MCP boundary.
4. Make approval compare-and-swap on the expected revision and record local actor/timestamp.
5. Keep approved revisions immutable. A change must create a successor; rollback is selection of an earlier approved revision.
6. Let the cockpit read a brief and submit guarded approval only; it must not create, edit, route, or execute one.

## Required tests

- Draft approval, stale approval rejection, immutability, and successor linkage.
- Bad/unknown component id rejection.
- Web boundary test still forbids browser imports of run start/log/cycle advance.

## Completion evidence

- An approved brief can be consumed by later stories without reading mutable chat text.
- Existing plans/stories require no migration and existing project startup still works.

## Stop conditions

- Never store a library path or host-specific file path in a brief.
- Never modify `state.json`, generated manifests, or index files directly.
