/**
 * The persistent notice log, and the one door restored.
 *
 * Module state, not per-component — the same shape `useToasts.ts` already
 * uses, and for the same reason `ui/notifications.js`'s own `history`/`unread`
 * lived at module scope: the log survives a tab switch because it never lived
 * inside a hidden panel's own DOM in the first place. `NoticeFeed.vue`, its
 * one renderer, is a thin template over what this module holds.
 *
 * Three doors feed `record()`, matching `ui/notifications.js:15-22`'s own
 * `notify()` exactly:
 *
 *  1. `onNotice` below — the two `{type:'notice'}` frames the queue sends,
 *     subscribed once, for the module's lifetime (the page's).
 *  2. `record()` itself, called from `App.vue`'s installed announcer
 *     alongside the toast for every write receipt, so the ephemeral toast and
 *     the durable log can never disagree about what was shown.
 *  3. `deriveEvents`, watched against the store's own `snapshot` below — the
 *     snapshot transitions neither of the above was ever wired to announce: a
 *     story finishing, a plan completing, config becoming unreadable, a cycle
 *     or a verification failing. `drawNoticeFeed` (`notifications.js:119-122`)
 *     is this same diff, ported.
 */
import { ref, watch } from 'vue'
import type { Message, Snapshot } from '../types/protocol.js'
import { onNotice, snapshot } from '../stores/session.js'
import { deriveEvents } from '../lib/notifications.js'

/** Bounded: this is a feed, not a log, and it is rendered. */
const LIMIT = 50

const open = ref(false)
const feed = ref<{ id: number; message: Message }[]>([])
/** `notifications.js:130-131`: unread, not total — and it resets to zero on open. */
const unread = ref(0)
let counter = 0

function record(message: Message): void {
  feed.value = [{ id: ++counter, message }, ...feed.value].slice(0, LIMIT)
  if (!open.value) unread.value += 1
}

// Door 1. Never unsubscribed — this module lives for the page's lifetime,
// the same as `ui/notifications.js`'s own module scope did.
onNotice(record)

// Door 3. `previous` starts `null` so the first snapshot a session ever sees
// announces nothing — `deriveEvents` itself keeps this same guard, and
// `watch`'s `immediate: true` firing on that very first snapshot must not
// bypass it.
let previous: Snapshot | null = null
watch(
  snapshot,
  (current) => {
    if (current === null) return
    // `deriveEvents`' `Event.code` is `NoticeCode`, and `record`'s parameter
    // is `Message`, whose `code` is the server's `WebCode` — two closed
    // unions, deliberately disjoint: nothing here is a wire message, so the
    // server has no reason to know these names. `record`/`feed` only ever
    // need a `{code, params?}` shape to hand to `Tx`, not which union `code`
    // came from, so the cast below is a shape widening, not a claim that the
    // two unions overlap. Both ends are now guarded independently —
    // `notices.test.ts` checks every `NoticeCode` has an `en`/`ar` key, the
    // same guarantee `locales.test.ts` already gives `WebCode`.
    for (const event of deriveEvents(previous, current)) record(event as unknown as Message)
    previous = current
  },
  { immediate: true },
)

function toggle(): void {
  open.value = !open.value
  if (open.value) unread.value = 0
}

export function useNotices() {
  return { open, feed, unread, record, toggle }
}
