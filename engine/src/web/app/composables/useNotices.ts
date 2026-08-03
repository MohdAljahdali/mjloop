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
import { onNotice, snapshot, type ClientCode } from '../stores/session.js'
import { deriveEvents, type NoticeCode } from '../lib/notifications.js'

/** Bounded: this is a feed, not a log, and it is rendered. */
const LIMIT = 50

/**
 * `code` accepts every union `record` is ever called with — the server's
 * `WebCode` (a write receipt, or a `{type:'notice'}` frame), `lib/notifications.ts`'s
 * own `NoticeCode` (a derived event), or `stores/session.ts`'s `ClientCode`
 * (a write refused before it ever reached the wire) — deliberately disjoint
 * from each other, since neither `deriveEvents` nor a refused-offline write
 * ever produces a wire message. `record`/`Tx` only ever need the
 * `{code, params?}` shape, not which union `code` came from, so widening it
 * here is what lets every door call `record` with no cast at all.
 */
type Entry = { code: Message['code'] | NoticeCode | ClientCode; params?: Record<string, string | number> }

const open = ref(false)
const feed = ref<{ id: number; at: string; message: Entry }[]>([])
/** `notifications.js:130-131`: unread, not total — and it resets to zero on open. */
const unread = ref(0)
let counter = 0

function record(message: Entry): void {
  // `notifications.js`'s own `Entry.at` — an ISO timestamp taken the moment
  // the entry is recorded, not read off anything the server sent. `NoticeFeed.vue`
  // renders it through `fmt.ts`'s `stamp()`, the same "date and time, for
  // something that happened once" formatter an approval or a halt uses.
  feed.value = [{ id: ++counter, at: new Date().toISOString(), message }, ...feed.value].slice(0, LIMIT)
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
    for (const event of deriveEvents(previous, current)) record(event)
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
