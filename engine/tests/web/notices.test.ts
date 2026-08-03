// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import type { ServerMessage } from '../../src/web/protocol.js'
import { emptySnapshot } from './helpers/page.js'

/**
 * A socket the test drives by hand — the same double `store.test.ts` uses.
 */
class FakeSocket {
  static last: FakeSocket | null = null
  sent: string[] = []
  readyState = 1
  listeners = new Map<string, (event: any) => void>()
  constructor(public url: string) {
    FakeSocket.last = this
  }
  addEventListener(type: string, fn: (event: any) => void) {
    this.listeners.set(type, fn)
  }
  send(data: string) {
    this.sent.push(data)
  }
  emit(type: string, event?: any) {
    this.listeners.get(type)?.(event)
  }
  deliver(message: ServerMessage) {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

let store: typeof import('../../src/web/app/stores/session.ts')
let notices: typeof import('../../src/web/app/composables/useNotices.ts')

beforeEach(async () => {
  vi.resetModules()
  store = await import('../../src/web/app/stores/session.ts')
  notices = await import('../../src/web/app/composables/useNotices.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as any })
})

describe('useNotices', () => {
  it('records a server-pushed {type:"notice"} frame — door 1', () => {
    const { feed, unread } = notices.useNotices()
    FakeSocket.last?.deliver({ type: 'notice', message: { code: 'notice.config.missing' } })
    expect(unread.value).toBe(1)
    expect(feed.value[0]?.message).toEqual({ code: 'notice.config.missing' })
  })

  it('records whatever is passed to record() — door 2, the one App.vue calls alongside the toast', () => {
    const { feed, unread, record } = notices.useNotices()
    record({ code: 'write.ok.halt' })
    expect(unread.value).toBe(1)
    expect(feed.value[0]?.message).toEqual({ code: 'write.ok.halt' })
  })

  it('announces nothing on the first snapshot a session ever sees — door 3\'s own guard', async () => {
    const { unread, feed } = notices.useNotices()
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot() })
    await nextTick()
    expect(unread.value).toBe(0)
    expect(feed.value).toHaveLength(0)
  })

  it('derives a story-done event from a snapshot transition — door 3, ported from drawNoticeFeed', async () => {
    const { unread, feed } = notices.useNotices()
    // A second, still-open story keeps the plan itself from completing, so
    // only `notice.story.done` fires — `notice.plan.done` is exercised on
    // its own below.
    const ready = emptySnapshot({
      plans: [
        {
          id: 'P001',
          title: 'Plan',
          approval: null,
          stories: [
            { id: 'P001-S01', title: 'Story', status: 'ready', ui: false, depends_on: [] },
            { id: 'P001-S02', title: 'Story 2', status: 'blocked', ui: false, depends_on: [] },
          ],
        },
      ],
    })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: ready })
    await nextTick()
    expect(unread.value).toBe(0)

    const done = emptySnapshot({
      plans: [
        {
          id: 'P001',
          title: 'Plan',
          approval: null,
          stories: [
            { id: 'P001-S01', title: 'Story', status: 'done', ui: false, depends_on: [] },
            { id: 'P001-S02', title: 'Story 2', status: 'blocked', ui: false, depends_on: [] },
          ],
        },
      ],
    })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: done })
    await nextTick()
    expect(unread.value).toBe(1)
    expect(feed.value[0]?.message).toEqual({ code: 'notice.story.done', params: { id: 'P001-S01' } })
  })

  it('derives a plan-done event once every story in it is done', async () => {
    const { unread, feed } = notices.useNotices()
    const inProgress = emptySnapshot({
      plans: [{ id: 'P002', title: 'Plan', approval: null, stories: [{ id: 'P002-S01', title: 'Story', status: 'ready', ui: false, depends_on: [] }] }],
    })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: inProgress })
    await nextTick()
    expect(unread.value).toBe(0)

    const complete = emptySnapshot({
      plans: [{ id: 'P002', title: 'Plan', approval: null, stories: [{ id: 'P002-S01', title: 'Story', status: 'done', ui: false, depends_on: [] }] }],
    })
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: complete })
    await nextTick()
    // Both fire — the story finished and, in the same transition, the plan
    // did too — the same pair `deriveEvents` itself produces.
    expect(unread.value).toBe(2)
    expect(feed.value.map((entry) => entry.message.code).sort()).toEqual(['notice.plan.done', 'notice.story.done'])
  })

  it('derives a config-missing event the same way — a category no receipt or queue frame was ever wired to announce', async () => {
    const { unread, feed } = notices.useNotices()
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot() })
    await nextTick()
    expect(unread.value).toBe(0)

    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ state: { ...emptySnapshot().state, config_error: 'config.yaml:1: bad key' } }) })
    await nextTick()
    expect(unread.value).toBe(1)
    expect(feed.value[0]?.message).toEqual({ code: 'notice.config.missing' })
  })

  it('resets unread, not the feed, when the panel opens — notifications.js:130-131', () => {
    const { unread, feed, record, toggle } = notices.useNotices()
    record({ code: 'write.ok.halt' })
    record({ code: 'write.ok.gate' })
    expect(unread.value).toBe(2)

    toggle()
    expect(unread.value).toBe(0)
    expect(feed.value).toHaveLength(2)
  })
})
