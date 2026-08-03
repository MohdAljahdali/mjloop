/**
 * The state behind Skills.vue's search form — `panels/skills.js`'s own
 * `search` object and `searchSkills`, ported.
 *
 * A search is a question a person asked once, not a document that follows a
 * revision — `useFeed`/`feed()` is the wrong tool here, because it re-fetches
 * whenever a dependency moves, and re-asking a query every time `.mjloop/`
 * changes would turn one keystroke into an unbounded stream of outbound
 * requests. So this holds the last answer in a plain ref instead, exactly as
 * the old module-scope object did, scoped per panel instance rather than to
 * the module — the panel is the thing `<KeepAlive>` keeps alive, so the
 * state survives a tab switch the same way it did before.
 *
 * `generation` is the same guard `feed()` applies to its own counter, for the
 * same reason: fire a second search before the first answer lands, and
 * without this the first answer can resolve *after* the second and overwrite
 * it — the panel would then show results for a query that is no longer in
 * the input.
 */
import { ref, type Ref } from 'vue'
import { get } from '../lib/api.js'
import type { SkillCandidate } from '../types/protocol.js'

export interface SkillSearch {
  candidates: Ref<SkillCandidate[]>
  code: Ref<string | null>
  asked: Ref<boolean>
  search: (q: string, source: string) => Promise<void>
}

export function useSkillSearch(): SkillSearch {
  const candidates = ref<SkillCandidate[]>([])
  const code = ref<string | null>(null)
  const asked = ref(false)
  let generation = 0

  async function search(q: string, source: string): Promise<void> {
    const query = q.trim()
    // The same floor the route enforces, checked here so a one-character
    // query is a no-op rather than a round trip that comes back 400.
    if (query.length < 2) return

    const mine = ++generation
    const answer = await get(`/api/skills/search?q=${encodeURIComponent(query)}&source=${encodeURIComponent(source)}`)
    // A later search already started; this answer belongs to a query nobody
    // is waiting for any more and must be dropped rather than drawn.
    if (mine !== generation) return

    asked.value = true
    if (answer.ok) {
      candidates.value = Array.isArray(answer.body?.candidates) ? answer.body.candidates : []
      code.value = null
    } else {
      candidates.value = []
      code.value = answer.code
    }
  }

  return { candidates, code, asked, search }
}
