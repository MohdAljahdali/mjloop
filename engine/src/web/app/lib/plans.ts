/**
 * Plans — the two joins the Plans panel's detail draws from, ported from
 * `panels/plans.js`. Both are pure and DOM-free, which is why they live here
 * rather than on `Plans.vue`.
 */
import type { MemoryView, RunSummary } from '../types/protocol.js'

/**
 * The runs whose directory names one of this plan's own stories.
 *
 * `RunSummary.story` (`readRuns`, `web/read.ts:467-495`) is parsed out of the
 * run *directory name* — `<run_id>--<story|adhoc>--<track>` — never stored
 * against a plan anywhere on disk, so this is a convention read off a path,
 * not a foreign key: the same one `panels/stories.js` already filters on for
 * a single story's own history, widened here to every story this plan
 * carries. An ad-hoc run's directory names no story at all — `readRuns` maps
 * that segment to `null` — so it can never be attributed to any plan; that is
 * the fact the directory name itself records, not a gap in this filter.
 */
export function planRuns(runs: readonly RunSummary[], plan: { stories: readonly { id: string }[] }): RunSummary[] {
  const ids = new Set(plan.stories.map((story) => story.id))
  return runs.filter((entry) => entry.story !== null && ids.has(entry.story))
}

/**
 * The memories scoped to this plan itself, or to one of its stories.
 *
 * A real join: `MemoryFrontmatterSchema` (`schemas/memory.ts`) carries `plan`
 * and `story` fields precisely so this could stop being a text match. A
 * memory matches when its own `plan` names this plan, or its `story` names
 * one of this plan's stories — the same two ways `mjloop_memory_add` can
 * scope an entry. A memory naming neither is project-wide and belongs to no
 * plan's list, which is what a title or body that merely *mentions* a plan
 * id in passing used to get wrong.
 */
export function planMemories(
  memories: readonly MemoryView[],
  plan: { id: string; stories: readonly { id: string }[] },
): MemoryView[] {
  const storyIds = new Set(plan.stories.map((story) => story.id))
  return memories.filter((memory) => memory.plan === plan.id || (memory.story !== null && storyIds.has(memory.story)))
}
