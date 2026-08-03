/**
 * The one connection, the one snapshot, and the one write door.
 *
 * No Pinia: the state is a single object the server pushes whole, and a module
 * holding refs is the smallest thing that models that honestly.
 */
import { computed, ref, shallowReadonly, shallowRef } from 'vue'
import type { ClientMessage, Message, ServerMessage, Snapshot, Write } from '../types/protocol.js'

export type Receipt = { id: string; ok: boolean; code: Message['code'] }
export type OutputFrame = { kind: 'append' | 'replace'; jobId: string; data: string }

/** The slice of `WebSocket` this module uses, so a test can hand it a fake. */
export interface WebSocketLike {
  readyState: number
  send: (data: string) => void
  addEventListener: (type: string, fn: (event: any) => void) => void
}

const RETRY_MS = 1000

/**
 * `shallowRef`, and this is the migration's load-bearing performance decision.
 *
 * The server replaces this object up to 1.25 times a second. A deep proxy would
 * walk `plans[].stories[]` and `queue[]` on every broadcast to watch for
 * mutations that never come — nothing on this page writes to a snapshot field.
 * Atomic replacement is exactly what `shallowRef` means.
 */
const held = shallowRef<Snapshot | null>(null)
const connected = ref(false)

export const snapshot = shallowReadonly(held) as Readonly<typeof held>
export const online = shallowReadonly(connected)
export const activeJob = computed(() => held.value?.session.jobId ?? null)

const outputSubscribers = new Set<(frame: OutputFrame) => void>()
const noticeSubscribers = new Set<(message: Message) => void>()

let socket: WebSocketLike | null = null
let token = ''
let factory: (url: string) => WebSocketLike = (url) => new WebSocket(url)
let started = false

/**
 * Idempotent: a second call updates the token and factory but does not open a
 * second socket. Nothing tears down the first connection's retry chain, so a
 * second `open()` would race it forever over the module-level `socket`.
 */
export function connect(ports: { token: string; socketFactory?: (url: string) => WebSocketLike }): void {
  token = ports.token
  if (ports.socketFactory !== undefined) factory = ports.socketFactory
  if (started) return
  started = true
  open()
}

function open(): void {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const next = factory(`${scheme}://${location.host}/?t=${encodeURIComponent(token)}`)
  socket = next

  next.addEventListener('open', () => (connected.value = true))
  next.addEventListener('message', (event: { data: unknown }) => receive(String(event.data)))
  next.addEventListener('close', () => {
    connected.value = false
    // Silent and automatic. The usual cause is the server restarting under a
    // rebuild, and the page recovers on its own.
    setTimeout(open, RETRY_MS)
  })
}

function receive(raw: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Nothing on this socket but our own server. A frame that is not JSON is
    // not a case to recover from, it is a case to ignore.
    return
  }
  if (typeof parsed !== 'object' || parsed === null) return
  const message = parsed as ServerMessage
  if (message.type === 'snapshot') held.value = message.snapshot
  else if (message.type === 'output') emit({ kind: 'append', jobId: message.jobId, data: message.data })
  else if (message.type === 'transcript') emit({ kind: 'replace', jobId: message.jobId, data: message.data })
  else if (message.type === 'notice') for (const fn of noticeSubscribers) fn(message.message)
  else if (message.type === 'receipt') settle(message)
}

/**
 * Output never becomes reactive state.
 *
 * A running agent emits thousands of lines a second. Routed through a ref, each
 * one would schedule a render of a component whose only job is to hand the
 * bytes to xterm, which keeps its own buffer anyway.
 */
function emit(frame: OutputFrame): void {
  for (const fn of outputSubscribers) fn(frame)
}

export function onOutput(fn: (frame: OutputFrame) => void): () => void {
  outputSubscribers.add(fn)
  return () => void outputSubscribers.delete(fn)
}

export function onNotice(fn: (message: Message) => void): () => void {
  noticeSubscribers.add(fn)
  return () => void noticeSubscribers.delete(fn)
}

/** Reports whether the frame actually went out, so a caller can react to a dead socket. */
export function send(message: ClientMessage): boolean {
  if (socket === null || socket.readyState !== 1) return false
  socket.send(JSON.stringify(message))
  return true
}

/** Pending writes by correlation id, so a receipt knows what it answers. */
const pending = new Map<string, { undo?: Write; settled?: (receipt: Receipt) => void }>()
let counter = 0

/**
 * Every write carries what was on record when the button was pressed, and the
 * server evaluates that inside the lock the op already takes. So: no optimistic
 * render, no rollback, no confirmation dialog on anything reversible — a stale
 * click is refused rather than obeyed. The snapshot broadcast goes out before
 * the receipt, so by the time one arrives the page already shows the result.
 */
export function submit(write: Write, options: { undo?: Write; settled?: (receipt: Receipt) => void } = {}): void {
  const id = `w${++counter}`
  if (!send({ type: 'write', id, write })) {
    // The socket is down. Refusing here rather than holding the write is the
    // same contract as a stale refusal from the server: nothing happened, and
    // the page says so. The offline banner is already on screen with the why.
    options.settled?.({ id, ok: false, code: 'write.failed' })
    announce({ code: 'write.failed' })
    return
  }
  pending.set(id, options)
}

type Announcer = (message: Message, action?: { code: string; run: () => void }) => void
let announce: Announcer = () => {}

/** Installed once from `App.vue`, so the store never imports a component. */
export function installAnnouncer(fn: Announcer): void {
  announce = fn
}

function settle(receipt: Receipt): void {
  const heldWrite = pending.get(receipt.id)
  if (heldWrite === undefined) return
  pending.delete(receipt.id)
  heldWrite.settled?.(receipt)

  // A refusal is worth saying out loud: the user pressed something, it did not
  // happen, and the reason is that the world moved underneath them. There is
  // nothing to undo, because nothing was done.
  if (!receipt.ok) {
    announce({ code: receipt.code })
    return
  }
  const undo = heldWrite.undo
  if (undo === undefined) {
    announce({ code: receipt.code })
    return
  }
  announce({ code: receipt.code }, { code: 'write.undo', run: () => submit(undo) })
}

/** Test seam: production drives `emit` from a socket frame. */
export function __emitForTest(frame: OutputFrame): void {
  emit(frame)
}
