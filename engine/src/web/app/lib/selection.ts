/**
 * What the reader is looking at: which plan, and which story filter.
 *
 * Selection used to be a `let` inside whichever panel owned the screen, which
 * made it invisible to every other module and to a reload. Two workspaces read
 * it now, so it lives here, behind `lib/local.js` — per browser, not per
 * project, which is the honest scope: the engine has no notion of an active
 * plan, and inventing one would need a write kind `web/writes.ts` denies.
 *
 * Deliberately pull, not push. `ui/render.js` skips a hidden panel and
 * `ui/tabs.js`'s `showTab` ends with a `draw()`, so a panel that was closed
 * while the selection moved re-reads it on the frame it becomes visible. There
 * is nothing to subscribe to and nothing to unsubscribe from.
 *
 * No cache: `read()` is a field access on a cache `lib/local.js` already holds,
 * and a second copy here would be one more thing a test has to reset.
 */
import { read, write } from './local.js'
import type { OpenStory } from './local.js'

/**
 * The plan whose detail is open, or null.
 *
 * Null is a real answer and not an absence: a reader who closed the detail has
 * chosen to look at the list.
 */
export function activePlan(): string | null {
  return read().activePlan
}

/**
 * `../composables/useSelection.ts`'s `setActivePlan` is the only door a
 * component should use — it keeps that module's reactive mirror in step with
 * this write. Calling this one directly from a panel would move storage
 * without moving the ref anything is `watch()`ing, the same class of bug
 * `useI18n.ts`'s own comment on `applyLocale` guards against for `setLocale`.
 * This export exists for `useSelection.ts` itself and for tests that read or
 * seed raw storage.
 */
export function setActivePlan(id: string | null): void {
  if (read().activePlan === id) return
  write({ activePlan: id })
}

/**
 * The story filter, as one of `lib/stories.js`'s `FILTERS`.
 *
 * A value this page does not know shows every story rather than none — see the
 * parse branch in `lib/local.js`.
 */
export function storyFilter(): string {
  return read().storyFilter
}

export function setStoryFilter(filter: string): void {
  if (read().storyFilter === filter) return
  write({ storyFilter: filter })
}

/**
 * The story tabs the reader has open, oldest first.
 *
 * Session state in spirit and per-browser in fact: they are not in the hash,
 * because a tab opening and closing is not a place you navigated to and
 * back/forward through twelve of them is nobody's idea of history.
 */
export function openStories(): readonly OpenStory[] {
  return read().openStories
}

/**
 * The tab being read, or null.
 *
 * Stored, but never trusted on its own: it is checked against the open set on
 * every read and falls back to the last tab. So the two can never disagree, and
 * a stored id whose tab has since closed cannot leave the pane pointing at
 * nothing.
 *
 * It is *not* derived from the tab order, which was the first shape and was
 * wrong: making "active" mean "last" forces selecting a tab to move it, and a
 * strip that reorders itself under the reader's pointer every time they press
 * an arrow key is not a strip anybody can keyboard through.
 */
export function activeStory(): string | null {
  const { activeStory: held, openStories: open } = read()
  if (held !== null && open.some((tab) => tab.id === held)) return held
  return open.length === 0 ? null : (open[open.length - 1]?.id ?? null)
}

/**
 * Open a story, or select it if it is already open.
 *
 * Appends. An already-open tab keeps its place in the strip — its position is
 * where the reader last saw it, and moving it is a second thing happening that
 * nobody asked for.
 */
export function openStory(id: string): void {
  const open = read().openStories
  if (open.some((tab) => tab.id === id)) {
    write({ activeStory: id })
    return
  }
  write({ openStories: [...open, { id, pinned: false }], activeStory: id })
}

export function closeStory(id: string): void {
  const open = read().openStories
  if (!open.some((tab) => tab.id === id)) return
  const left = open.filter((tab) => tab.id !== id)
  write({
    openStories: left,
    // Bounded, and most-recent-first, so reopening walks backwards through what
    // was closed rather than forwards through a log.
    recentlyClosed: [id, ...read().recentlyClosed.filter((entry) => entry !== id)].slice(0, 10),
    // Closing the tab you were reading hands you the one beside it rather than
    // an empty pane.
    activeStory: read().activeStory === id ? (left[left.length - 1]?.id ?? null) : read().activeStory,
  })
}

export function pinStory(id: string): void {
  const open = read().openStories
  if (!open.some((tab) => tab.id === id)) return
  write({ openStories: open.map((tab) => (tab.id === id ? { id: tab.id, pinned: !tab.pinned } : tab)) })
}

/**
 * The most recently closed tab, put back where it was closed from.
 *
 * @returns the id reopened, or null if there was nothing to reopen.
 */
export function reopenStory(): string | null {
  const [first, ...rest] = read().recentlyClosed
  if (first === undefined) return null
  write({ recentlyClosed: rest })
  openStory(first)
  return first
}

export function recentlyClosed(): readonly string[] {
  return read().recentlyClosed
}
