// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerMessage } from '../../src/web/protocol.js'
import { emptySnapshot } from './helpers/page.js'

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
  vi.resetModules()
  store = await import('../../src/web/app/stores/session.ts')
  store.connect({ token: 'tok', socketFactory: (url) => new FakeSocket(url) as any })
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

describe('snapshots', () => {
  it('replaces the held snapshot wholesale', () => {
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ project: '/a' }) })
    expect(store.snapshot.value?.project).toBe('/a')
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: emptySnapshot({ project: '/b' }) })
    expect(store.snapshot.value?.project).toBe('/b')
  })

  it('is not deeply reactive', () => {
    const snap = emptySnapshot()
    FakeSocket.last?.deliver({ type: 'snapshot', snapshot: snap })
    // shallowRef, so what comes back is the very object the socket delivered —
    // no proxy walked over plans[].stories[] and queue[] 1.25 times a second.
    expect(store.snapshot.value).toBe(snap)
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
    const notices: unknown[] = []
    store.onNotice((message) => notices.push(message))
    store.submit({ kind: 'gate', run: 'r', open: true }, { undo: { kind: 'gate', run: 'r', open: false } })
    const id = JSON.parse(FakeSocket.last?.sent[0] ?? '{}').id
    FakeSocket.last?.deliver({ type: 'receipt', id, ok: false, code: 'write.stale' })
    // A refusal is announced, but there is nothing to undo: it did not happen.
    expect(notices).toEqual([{ code: 'write.stale' }])
  })
})
