/**
 * Faceting the memory list — `panels/memory.js`'s `facet`, ported.
 *
 * Client-side because it has to be: `memorySearch` (`web/read.ts`) filters by
 * none of kind, tag, time or run, so there is nothing to push to the server.
 * DOM-free and node-testable, which is why it lives here rather than on
 * `Memory.vue` itself.
 */
import type { MemoryView } from '../types/protocol.js'

/**
 * Every memory whose kind matches (when one is chosen) and whose id, title,
 * tags and body together contain every whitespace-separated term of `query`
 * — case-insensitively, and every term independently rather than as one
 * phrase, so word order in the box never matters.
 */
export function facet(memories: readonly MemoryView[], query: string, kind: string): MemoryView[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
  return memories.filter((memory) => {
    if (kind !== '' && memory.kind !== kind) return false
    if (terms.length === 0) return true
    const haystack = `${memory.id} ${memory.title} ${memory.tags.join(' ')} ${memory.body}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}
