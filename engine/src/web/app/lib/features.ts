/**
 * Whether a feature brief can be approved from here, and why not when it
 * cannot.
 *
 * `panels/features.js`'s own `approvable`, ported unchanged: the whole of the
 * approve button's policy, and the one piece of the Features panel worth
 * testing without a DOM. The two refusals are not the same kind of thing: a
 * non-draft is a state the page can see and describe, and an empty
 * acceptance list is a schema rule the server would answer with a code that
 * says nothing about acceptance criteria.
 */
import type { FeatureDetail } from '../types/protocol.js'

export function approvable(detail: FeatureDetail | null): { can: boolean; why: string | null } {
  if (detail === null) return { can: false, why: null }
  if (detail.status !== 'draft') return { can: false, why: null }
  if (detail.brief.acceptance.length === 0) return { can: false, why: 'features.needsAcceptance' }
  return { can: true, why: null }
}
