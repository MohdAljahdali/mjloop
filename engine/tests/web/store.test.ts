// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProxy } from 'vue'
import type { ServerMessage } from '../../src/web/protocol.js'
import { emptySnapshot } from './helpers/page.js'

/**
 * `session.ts`'s own `RETRY_MS` — not exported, so mirrored here. A close
 * event schedules a real `setTimeout(open, RETRY_MS)`; every test in this
 * file runs under fake timers precisely so that a `'close'` emitted anywhere
 * below never leaves a live 1000ms timer running past the test that fired
 * it — the leak `store.test.ts` used to have, and the reason reconnection
 * itself had no test at all: nothing here could advance a clock nobody
 * controlled.
 */
const RETRY_MS = 1000

/**
 * A socket the test drives by hand. The store must never construct a real one
 * in a test environment, which is why `connect` takes a factory.
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

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as any })
})

afterEach(() => {
  // Discards any timer a test left pending (a scheduled reconnect, chiefly)
  // rather than letting it fire for real once fake timers stop intercepting it.
  vi.useRealTimers()
})

describe('the connection', () => {
  it('carries the token in the url', () => {
    expect(FakeSocket.last?.url).toContain('t=tok')
  })

  it('reports online only while open', () => {
    expect(store.online.value).toBe(false)
    FakeSocket.last?.emit('open')
    expect(store.online.value).toBe(true)
    FakeSocket.last?.emit('close')
    expect(store.online.value).toBe(false)
  })
})

describe('reconnection', () => {
  it('does not retry before the delay, then opens a new socket and reports online again once it does', () => {
    FakeSocket.last?.emit('open')
    expect(store.online.value).toBe(true)
    const first = FakeSocket.last

    FakeSocket.last?.emit('close')
    expect(store.online.value).toBe(false)

    // Silent and automatic, but not immediate — nothing has reconnected yet.
    vi.advanceTimersByTime(RETRY_MS - 1)
    expect(FakeSocket.last).toBe(first)

    vi.advanceTimersByTime(1)
    expect(FakeSocket.last).not.toBe(first)
    expect(store.online.value).toBe(false)

    // The new socket carries the same token, and coming online again is
    // reported the same way the first connection was.
    expect(FakeSocket.last?.url).toContain('t=tok')
    FakeSocket.last?.emit('open')
    expect(store.online.value).toBe(true)
  })
})

describe('snapshots', () => {
  it('replaces the held snapshot wholesale', () => {
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ project: '/a' }) })
    expect(store.snapshot.value?.project).toBe('/a')
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ project: '/b' }) })
    expect(store.snapshot.value?.project).toBe('/b')
  })

  it('holds the snapshot raw, not behind a deep proxy', () => {
    const snap = emptySnapshot()
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: snap })
    // shallowRef + shallowReadonly: what comes back is the plain object, not a
    // proxy. A deep ref — or the readonly() this brief originally specified —
    // would walk plans[].stories[] and queue[] on every broadcast, 1.25 times
    // a second, to watch for mutations that never come.
    expect(isProxy(store.snapshot.value)).toBe(false)
    expect(store.snapshot.value).toStrictEqual(snap)
  })

  it('ignores a frame that is not json', () => {
    FakeSocket.last?.emit('message', { data: 'not json' })
    expect(store.snapshot.value).toBe(null)
  })
})

describe('output', () => {
  it('reaches subscribers without touching the snapshot', () => {
    const frames: unknown[] = []
    store.onOutput((frame) => frames.push(frame))
    FakeSocket.last?.deliver({ type: 'output', jobId: 'j1', data: 'hello' })
    FakeSocket.last?.deliver({ type: 'transcript', jobId: 'j1', data: 'all of it' })
    expect(frames).toEqual([
      { kind: 'append', jobId: 'j1', data: 'hello' },
      { kind: 'replace', jobId: 'j1', data: 'all of it' },
    ])
    expect(store.snapshot.value).toBe(null)
  })

  it('stops delivering after unsubscribe', () => {
    const frames: unknown[] = []
    const off = store.onOutput((frame) => frames.push(frame))
    off()
    FakeSocket.last?.deliver({ type: 'output', jobId: 'j1', data: 'x' })
    expect(frames).toEqual([])
  })
})

describe('writes', () => {
  it('sends a correlated write frame', () => {
    store.submit({ kind: 'halt', run: 'run-1', reason: 'because' })
    const frame = JSON.parse(FakeSocket.last?.sent[0] ?? '{}')
    expect(frame.type).toBe('write')
    expect(frame.id).toMatch(/^w\d+$/)
    expect(frame.write).toEqual({ kind: 'halt', run: 'run-1', reason: 'because' })
  })

  it('settles the matching receipt exactly once', () => {
    const settled = vi.fn()
    store.submit({ kind: 'halt', run: 'run-1', reason: 'r' }, { settled })
    const id = JSON.parse(FakeSocket.last?.sent[0] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: true, code: 'write.ok.halt' })
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: true, code: 'write.ok.halt' })
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('offers the inverse write only when one was given and the write landed', () => {
    const announced: unknown[] = []
    store.installAnnouncer((message, action) => announced.push({ message, undo: action !== undefined }))

    store.submit(
      { kind: 'gate', plan: 'P001', from: null, to: 'approved', note: null },
      { undo: { kind: 'gate', plan: 'P001', from: 'approved', to: 'rejected', note: null } },
    )
    const first = JSON.parse(FakeSocket.last?.sent[0] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id: first, ok: false, code: 'write.stale.plan' })
    // Refused: announced, but there is nothing to undo — it did not happen.
    expect(announced).toEqual([{ message: { code: 'write.stale.plan' }, undo: false }])

    store.submit(
      { kind: 'gate', plan: 'P001', from: null, to: 'approved', note: null },
      { undo: { kind: 'gate', plan: 'P001', from: 'approved', to: 'rejected', note: null } },
    )
    const second = JSON.parse(FakeSocket.last?.sent[1] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id: second, ok: true, code: 'write.ok.gate' })
    expect(announced[1]).toEqual({ message: { code: 'write.ok.gate' }, undo: true })
  })

  it('settles as a refusal, and does not leave a pending entry, when the socket is down', () => {
    const socket = FakeSocket.last
    if (socket !== null) socket.readyState = 0
    const settled = vi.fn()
    const announced: unknown[] = []
    store.installAnnouncer((message) => announced.push(message))

    store.submit({ kind: 'halt', run: 'run-1', reason: 'r' }, { settled })

    // Nothing was written to the wire.
    expect(socket?.sent).toEqual([])
    // The caller is told immediately: a refusal, not silence.
    expect(settled).toHaveBeenCalledTimes(1)
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ ok: false, code: 'write.offline' }))
    expect(announced).toEqual([{ code: 'write.offline' }])

    // A receipt that later arrives under the same id (e.g. the socket came
    // back and the server, coincidentally, reused a correlation id) does not
    // settle this write a second time — there is nothing pending to match.
    const id = settled.mock.calls[0]?.[0]?.id
    if (socket !== null) socket.readyState = 1
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: true, code: 'write.ok.halt' })
    expect(settled).toHaveBeenCalledTimes(1)
  })
})

describe('connect', () => {
  it('is idempotent: a second call does not open a second socket', () => {
    const first = FakeSocket.last
    store.connect({ token: 'tok2', socketFactory: (url) => new FakeSocket(url) as any })
    expect(FakeSocket.last).toBe(first)
  })
})
